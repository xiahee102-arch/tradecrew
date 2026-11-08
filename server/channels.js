import {uid,now,query,one,run,records,record,put,audit,fail,active,quota} from './store.js';
import {PLANS,gatewayCheck} from './domain.mjs';
import {emailSend} from './email.js';
import {enqueue} from './agents.js';
const enc=new TextEncoder();
export async function hmac(secret,value){const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export function safeEqual(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0;}
async function vaultKey(env){if(!env.TOKEN_ENCRYPTION_KEY)fail('渠道密钥保险库尚未配置 TOKEN_ENCRYPTION_KEY，请由部署管理员配置。',503);return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',enc.encode(env.TOKEN_ENCRYPTION_KEY)),{name:'AES-GCM'},false,['encrypt','decrypt']);}
export async function vaultWrite(env,tenant,token){const key=await vaultKey(env),iv=crypto.getRandomValues(new Uint8Array(12)),ref='vault/'+tenant+'/'+uid();const data=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,enc.encode(token));await env.BUCKET.put(ref,JSON.stringify({iv:[...iv],data:[...new Uint8Array(data)]}));return ref;}
export async function vaultRead(env,ref){const obj=await env.BUCKET.get(ref);if(!obj)fail('渠道授权已丢失，请重新连接。',503);const {iv,data}=await obj.json();return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(iv)},await vaultKey(env),new Uint8Array(data)));}
export async function graph(env,path,token,body){
 const res=await fetch('https://graph.facebook.com/'+(env.META_GRAPH_VERSION||'v23.0')+'/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
 const data=await res.json();if(!res.ok){const e=Error('Meta 接口错误 '+(data.error?.code||res.status)+'：'+(data.error?.message||'请检查授权与账号状态'));e.retryable=res.status===429||res.status>=500;throw e;}return data;
}
export async function connect(env,tenant,body){
 if(!['whatsapp','facebook'].includes(body.channel))fail('目前支持 WhatsApp 与 Facebook 官方接口');
 if(!/^\d{5,30}$/.test(body.account_id||''))fail('请输入正确的号码 ID 或主页 ID');
 if(!body.token||body.token.length>5000)fail('请输入渠道访问令牌');
 if(!env.META_APP_SECRET||!env.META_VERIFY_TOKEN)fail('请先由管理员配置 Meta 应用密钥和 Webhook 验证令牌。',503);
 const check=await graph(env,body.account_id+'?fields='+(body.channel==='whatsapp'?'id,display_phone_number,verified_name':'id,name'),body.token);
 const existing=await one(env,'SELECT * FROM channels WHERE channel=? AND account_id=?',body.channel,body.account_id);
 if(existing&&existing.tenant!==tenant)fail('该渠道已绑定其他工厂',409);
 const token_ref=await vaultWrite(env,tenant,body.token),id=existing?.id||uid();
 await run(env,'INSERT INTO channels (id,tenant,channel,account_id,token_ref,health) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET token_ref=excluded.token_ref,health=excluded.health',id,tenant,body.channel,body.account_id,token_ref,'authorized');
 if(body.channel==='facebook')await graph(env,body.account_id+'/subscribed_apps',body.token,{subscribed_fields:['messages','messaging_postbacks','message_deliveries','message_reads']});
 await audit(env,tenant,'boss','channel.authorized',id,{channel:body.channel,account_id:body.account_id});return {id,name:check.verified_name||check.name||check.display_phone_number};
}
export async function ingest(env,tenant,{channel,external_id,name,text,event_id,origin='live',timestamp}){
 const eventKey=channel+':'+event_id;
 const inserted=await run(env,'INSERT OR IGNORE INTO channel_events VALUES (?,?,?,?,?,?)',eventKey,tenant,channel,JSON.stringify({external_id,text,timestamp,origin}),'received',now());
 if(!inserted.meta.changes)return {duplicate:true};
 let customer=(await records(env,tenant,'customer')).find(c=>c.data.channel===channel&&c.data.external_id===external_id);
 const opted=/^(stop|unsubscribe|停止|退订|berhenti)[.!\s]*$/i.test(text.trim());
 const customerId=customer?.id||uid(),window_expires_at=new Date((timestamp||Date.now())+86400000).toISOString();
 await put(env,tenant,'customer',{...customer?.data,name:name||customer?.data.name||external_id,channel,external_id,origin,window_expires_at,opted_out:opted||customer?.data.opted_out||false,last_text:text,last_message_at:now()},customerId);
 const messageId=await put(env,tenant,'message',{customer_id:customerId,channel,direction:'in',text,origin,provider_message_id:event_id,delivery_status:'received'});
 await run(env,"UPDATE channel_events SET status='processed' WHERE id=?",eventKey);
 await audit(env,tenant,'channel-adapter','message.received',messageId,{channel,origin,event_id});
 if(opted)await audit(env,tenant,'gateway','customer.opted_out',customerId);
 else{
  const sub=await active(env,tenant),plan=sub?PLANS[sub.plan]:PLANS.monthly;
  const since=sub&&sub.plan==='trial'?sub.updated_at:new Date(new Date().getFullYear(),new Date().getMonth(),1).toISOString();
  try{await quota(env,tenant,'inquiry',customerId,plan.inquiries,since);await enqueue(env,tenant,'service','reply',{customer_id:customerId,message_id:messageId});}
  catch(e){await put(env,tenant,'blocker',{title:'询盘配额已用完',detail:e.message,customer_id:customerId,status:'open'});}
 }
 return {customer_id:customerId,message_id:messageId};
}
export async function webhook(env,request,ctx,drain){
 const url=new URL(request.url);
 if(request.method==='GET'){if(env.META_VERIFY_TOKEN&&safeEqual(url.searchParams.get('hub.verify_token'),env.META_VERIFY_TOKEN))return new Response(url.searchParams.get('hub.challenge'));return new Response('Forbidden',{status:403});}
 const raw=await request.text();if(!env.META_APP_SECRET||!safeEqual(request.headers.get('x-hub-signature-256'),'sha256='+await hmac(env.META_APP_SECRET,raw)))return new Response('Invalid signature',{status:401});
 const payload=JSON.parse(raw),rawIds=[];
 const rawHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(raw)))].map(x=>x.toString(16).padStart(2,'0')).join('');
 for(const entry of payload.entry||[]){
  const accounts=[entry.id,...(entry.changes||[]).map(c=>c.value?.metadata?.phone_number_id)].filter(Boolean);
  for(const account of accounts){const c=await one(env,"SELECT * FROM channels WHERE account_id=? AND health!='disconnected'",account);if(!c||c.health==='disconnected')continue;
   const rawId='meta_raw:'+c.tenant+':'+rawHash;
   const r=await run(env,'INSERT OR IGNORE INTO channel_events VALUES (?,?,?,?,?,?)',rawId,c.tenant,'meta_raw',raw,'received',now());if(r.meta.changes)rawIds.push(rawId);
  }
 }
 if(!rawIds.length)return new Response('EVENT_RECEIVED');
 ctx.waitUntil((async()=>{
 const touched=new Set();
 for(const entry of payload.entry||[]){
  for(const change of entry.changes||[]){const v=change.value||{},account=v.metadata?.phone_number_id;if(!account)continue;
   const c=await one(env,"SELECT * FROM channels WHERE channel='whatsapp' AND account_id=?",account);if(!c||c.health==='disconnected')continue;
   await run(env,"UPDATE channels SET health='connected',last_webhook_at=? WHERE id=?",now(),c.id);touched.add(c.tenant);
   for(const msg of v.messages||[]){if(msg.type==='text')await ingest(env,c.tenant,{channel:'whatsapp',external_id:msg.from,name:v.contacts?.find(x=>x.wa_id===msg.from)?.profile?.name,text:msg.text.body,event_id:msg.id,timestamp:Number(msg.timestamp)*1000});}
   for(const st of v.statuses||[])await updateDelivery(env,c.tenant,st.id,st.status);
  }
  for(const event of entry.messaging||[]){
   const c=await one(env,"SELECT * FROM channels WHERE channel='facebook' AND account_id=?",entry.id);if(!c||c.health==='disconnected')continue;touched.add(c.tenant);
   await run(env,"UPDATE channels SET health='connected',last_webhook_at=? WHERE id=?",now(),c.id);
   if(event.message?.text&&!event.message.is_echo)await ingest(env,c.tenant,{channel:'facebook',external_id:event.sender.id,text:event.message.text,event_id:event.message.mid,timestamp:event.timestamp});
   for(const mid of event.delivery?.mids||[])await updateDelivery(env,c.tenant,mid,'delivered');
  }
 }
 for(const rawId of rawIds)await run(env,"UPDATE channel_events SET status='processed' WHERE id=?",rawId);
 for(const t of touched)await drain(env,t,send);
 })());return new Response('EVENT_RECEIVED');
}
async function updateDelivery(env,tenant,ref,status){const messages=await records(env,tenant,'message');for(const m of messages)if(m.data.provider_message_id===ref)await put(env,tenant,'message',{...m.data,delivery_status:status},m.id);}
export async function send(env,tenant,id){
 const out=await record(env,tenant,id);if(!out||out.kind!=='outbox')fail('出站项不存在',404);
 const customer=await record(env,tenant,out.data.customer_id);if(!customer||customer.kind!=='customer')fail('客户不存在',404);
 if(customer.data.origin!=='live')fail('手动录入的消息不会通过真实渠道发送，请在买家原渠道操作。');
 const check=gatewayCheck(out.data,{facts:await records(env,tenant,'fact'),customer:customer.data});if(!check.pass){await put(env,tenant,'outbox',{...out.data,status:'blocked',block_reasons:check.reasons},id);fail(check.reasons.join('；'));}
 const dispatch=await one(env,'SELECT * FROM dispatches WHERE id=? AND tenant=?',id,tenant);
 if(dispatch?.status==='sent')return {provider_ref:dispatch.provider_ref,duplicate:true};
 if(dispatch?.status==='sending'||dispatch?.status==='uncertain')fail('该消息处于发送中或结果不确定，请核对渠道记录后人工处理，避免重复。',409);
 const c=await one(env,'SELECT * FROM channels WHERE tenant=? AND channel=?',tenant,out.data.channel);if(!c||c.health==='disconnected')fail('渠道未连接或需要重新授权',503);
 const acquired=await run(env,"INSERT INTO dispatches (id,tenant,status,updated_at) VALUES (?,?,'sending',?) ON CONFLICT(id) DO UPDATE SET status='sending',updated_at=excluded.updated_at WHERE dispatches.status='failed'",id,tenant,now());if(!acquired.meta.changes)fail('已被其他发送任务占用',409);
 try{
  const token=c.channel==='email'?null:await vaultRead(env,c.token_ref),response=c.channel==='email'?{message_id:await emailSend(env,c,customer.data,out.data,id)}:await graph(env,c.account_id+'/messages',token,c.channel==='whatsapp'?{messaging_product:'whatsapp',to:customer.data.external_id,type:'text',text:{body:out.data.text}}:{recipient:{id:customer.data.external_id},message:{text:out.data.text},messaging_type:'RESPONSE'});
  const ref=response.messages?.[0]?.id||response.message_id;if(!ref)throw Error('渠道没有返回消息编号');
  await run(env,"UPDATE dispatches SET status='sent',provider_ref=?,updated_at=? WHERE id=?",ref,now(),id);
  await put(env,tenant,'outbox',{...out.data,status:'sent',provider_ref:ref,sent_at:now()},id);
  await put(env,tenant,'message',{customer_id:customer.id,channel:out.data.channel,direction:'out',text:out.data.text,origin:'live',provider_message_id:ref,delivery_status:'sent',outbox_id:id});
  await audit(env,tenant,'gateway','message.sent',id,{provider_ref:ref});return {provider_ref:ref};
 }catch(e){
  // On transport/timeout failures Meta may already have received the message. Never blindly retry an uncertain send.
  const uncertain=/timeout|fetch|network|返回消息编号/i.test(e.message);
  await run(env,'UPDATE dispatches SET status=?,error=?,updated_at=? WHERE id=?',uncertain?'uncertain':'failed',e.message,now(),id);
  if(/190|token/i.test(e.message))await run(env,"UPDATE channels SET health='reauthorize' WHERE id=?",c.id);
  await audit(env,tenant,'gateway',uncertain?'message.uncertain':'message.failed',id,{reason:e.message});
  if(uncertain)e.retryable=false;throw e;
 }
}
