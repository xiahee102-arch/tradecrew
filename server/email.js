import {uid,now,one,run,record,put,audit,json,fail,active} from './store.js';
import {vaultWrite,vaultRead,safeEqual,ingest} from './channels.js';
import {enqueue,drain} from './agents.js';
import {send} from './channels.js';
const encode=new TextEncoder();
export async function resend(path,token,body,idempotency){
 const r=await fetch('https://api.resend.com/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(idempotency?{'Idempotency-Key':idempotency}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
 const data=await r.json();if(!r.ok){const e=Error('邮件服务请求失败（'+r.status+'）：'+(data.message||data.name||'请检查账号'));e.retryable=r.status===429||r.status>=500;throw e;}return data;
}
export async function connectEmail(env,tenant,b){
 const address=String(b.account_id||'').toLowerCase().trim();if(!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(address))fail('请输入正确的企业询盘邮箱');
 if(!b.token||!b.webhook_secret?.startsWith('whsec_'))fail('请提供 Resend API Key 和 Webhook 签名密钥');
 const domains=await resend('domains',b.token);const domain=address.split('@')[1];if(!domains.data?.some(d=>d.name===domain&&d.status==='verified'))fail('发送域名尚未在 Resend 完成验证。请先配置 SPF/DKIM。');
 const old=await one(env,"SELECT * FROM channels WHERE channel='email' AND account_id=?",address);if(old&&old.tenant!==tenant)fail('该邮箱已被其他工厂绑定',409);
 const ref=await vaultWrite(env,tenant,JSON.stringify({api_key:b.token,webhook_secret:b.webhook_secret})),id=old?.id||uid();
 await run(env,"INSERT INTO channels (id,tenant,channel,account_id,token_ref,health) VALUES (?,?,'email',?,?,'authorized') ON CONFLICT(id) DO UPDATE SET token_ref=excluded.token_ref,health='authorized'",id,tenant,address,ref);await audit(env,tenant,'boss','channel.authorized',id,{channel:'email',account_id:address});return {id,address,callback_path:'/webhooks/email?account='+id};
}
export async function emailWebhook(request,env,ctx){
 const url=new URL(request.url),account=await one(env,"SELECT * FROM channels WHERE id=? AND channel='email' AND health!='disconnected'",url.searchParams.get('account')||'');if(!account)return json({error:'Unknown email account'},404);
 const raw=await request.text(),secrets=JSON.parse(await vaultRead(env,account.token_ref));
 const id=request.headers.get('svix-id'),ts=request.headers.get('svix-timestamp'),signatures=request.headers.get('svix-signature')||'';
 if(!id||!ts||Math.abs(Date.now()/1000-Number(ts))>300)return json({error:'Invalid webhook timestamp'},401);
 const key=await crypto.subtle.importKey('raw',Uint8Array.from(atob(secrets.webhook_secret.slice(6)),c=>c.charCodeAt(0)),{name:'HMAC',hash:'SHA-256'},false,['sign']);const expected=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC',key,encode.encode(id+'.'+ts+'.'+raw)))));
 if(!signatures.split(' ').some(s=>s.startsWith('v1,')&&safeEqual(s.slice(3),expected)))return json({error:'Invalid email signature'},401);
 const event=JSON.parse(raw);if(event.type!=='email.received')return json({ok:true,ignored:true});
 const received=await run(env,'INSERT OR IGNORE INTO channel_events VALUES (?,?,?,?,?,?)','resend:'+id,account.tenant,'email_raw',JSON.stringify({event,account_id:account.id}),'received',now());
 if(received.meta.changes){await enqueue(env,account.tenant,'service','email_ingest',{event_id:'resend:'+id,account_id:account.id});ctx.waitUntil(drain(env,account.tenant,send));}
 return json({ok:true});
}
export async function processEmail(env,tenant,input){
 const account=await one(env,"SELECT * FROM channels WHERE id=? AND tenant=? AND channel='email' AND health!='disconnected'",input.account_id,tenant);if(!account)throw Error('邮箱已断开');
 const event=await one(env,"SELECT * FROM channel_events WHERE id=? AND tenant=?",input.event_id,tenant);if(!event)return {ignored:true};if(event.status==='processed')return {duplicate:true};
 const secrets=JSON.parse(await vaultRead(env,account.token_ref)),raw=JSON.parse(event.data),emailId=raw.event.data?.email_id;if(!emailId)throw Error('邮件事件缺少 email_id');
 const email=await resend('emails/receiving/'+encodeURIComponent(emailId),secrets.api_key);
 const recipients=(Array.isArray(email.to)?email.to:[email.to]).map(x=>String(x).toLowerCase());if(!recipients.includes(account.account_id))throw Error('邮件收件人与工厂询盘邮箱不符');
 const from=String(email.from||''),address=(from.match(/<([^>]+)>/)?.[1]||from).trim().toLowerCase();
 if(!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)||/[\r\n]/.test(address))throw Error('无法识别发件人');
 const headers=email.headers||{},auto=headers['auto-submitted']||headers['Auto-Submitted'];
 if((auto&&auto!=='no')||/mailer-daemon|postmaster|no-?reply/i.test(address)){await run(env,"UPDATE channel_events SET status='processed' WHERE id=?",input.event_id);return {ignored:'自动邮件不回复'};}
 const text=email.text||'';if(!text.trim())throw Error('邮件没有可读取的纯文本，请在原邮箱人工处理。');
 const result=await ingest(env,tenant,{channel:'email',external_id:address,name:from.replace(/<.*>/,'').trim()||address,text:text.slice(0,10000),event_id:emailId,origin:'live'});
 if(result.customer_id){const customer=await record(env,tenant,result.customer_id);await put(env,tenant,'customer',{...customer.data,email_subject:String(email.subject||'Inquiry').slice(0,300),email_message_id:email.message_id||raw.event.data.message_id,email_account_id:account.id},customer.id);}
 await run(env,"UPDATE channels SET health='connected',last_webhook_at=? WHERE id=?",now(),account.id);await run(env,"UPDATE channel_events SET status='processed' WHERE id=?",input.event_id);return result;
}
export async function emailSend(env,account,customer,outbox,id){
 if(!customer.email_message_id)fail('邮件缺少原始线程 Message-ID，禁止新建线程主动联系买家');
 const token=JSON.parse(await vaultRead(env,account.token_ref)).api_key;
 const subject=/^re:/i.test(customer.email_subject||'')?customer.email_subject:'Re: '+(customer.email_subject||'Your inquiry');
 const sent=await resend('emails',token,{from:account.account_id,to:[customer.external_id],subject,text:outbox.text,headers:{'In-Reply-To':customer.email_message_id,References:customer.email_message_id,'Auto-Submitted':'auto-replied'}},id);return sent.id;
}
