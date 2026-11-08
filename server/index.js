import {requestMimo} from './mimo.js';
import {routeGaps} from './manager.js';
import {connectEmail,emailWebhook} from './email.js';
import assets from '../work/assets.js';
import {AGENTS,PLANS,quoteCalc} from './domain.mjs';
import {uid,now,query,one,run,records,record,put,audit,active,json,fail} from './store.js';
import {enqueue,drain,model,intel} from './agents.js';
import {connect,webhook,send,ingest,hmac,safeEqual} from './channels.js';
import {tick} from './scheduler.js';
import {checkout,paymentWebhook} from './payments.js';
const KINDS=['document','fact','strategy','customer','message','requirement','quote','order','content','outbox','blocker','report','chat','invoice','price_profile','goal'];
async function body(request){const length=Number(request.headers.get('Content-Length')||0);if(length>22*1024*1024)fail('上传内容过大',413);return request.json();}
async function tenantId(request){return request.headers.get('oai-authenticated-user-id');}
async function api(request,env,ctx){
 const url=new URL(request.url),path=url.pathname,method=request.method;
 if(!env.DB)fail('数据库绑定尚未就绪，请检查 D1 部署配置。',503);
 if(method!=='GET'){
  const origin=request.headers.get('Origin');if(origin&&origin!==url.origin)fail('请求来源不匹配',403);
  if(!request.headers.get('Content-Type')?.includes('application/json'))fail('需要 JSON 请求',415);
 }
 const tenant=await tenantId(request);if(!tenant)fail('请先使用 ChatGPT 登录，建立你的工厂工作区。',401);
 const factory=await one(env,'SELECT * FROM tenants WHERE id=?',tenant);
 const b=method==='GET'?{}:await body(request);
 if(path==='/api/register'&&method==='POST'){
  if(factory)fail('工厂工作区已经存在',409);if(!b.factory?.trim()||b.factory.length>100||!b.category?.trim())fail('请输入工厂名称和主营品类');
  await run(env,'INSERT INTO tenants VALUES (?,?,?,?)',tenant,b.factory.trim(),b.category.trim(),now());await audit(env,tenant,'boss','factory.registered',tenant);if(env.LOCAL_DEV_MODE==='true'){await run(env,"INSERT INTO subscriptions (tenant,plan,status,expires_at,updated_at) VALUES (?,?,'development',?,?)",tenant,'trial',new Date(Date.now()+14*86400000).toISOString(),now());await audit(env,tenant,'system','local.development_access_granted',tenant,{paid:false,days:14});}return json({ok:true});
 }
 if(path==='/api/model/check'&&method==='POST'){
  const modelName=env.MIMO_FLASH_MODEL||'mimo-v2.6-flash',start=Date.now();
  const {data,output}=await requestMimo(env,{modelName,messages:[{role:'system',content:'只返回 JSON 对象。'},{role:'user',content:'返回 {"ok":true,"message":"连接成功"}'}],maxTokens:128});
  if(output.ok!==true)fail('模型连接检查没有通过，请重试。',502);
  const usage=data.usage||{};await run(env,'INSERT INTO usage VALUES (?,?,?,?,?,?,?,?)',uid(),tenant,'manager',modelName,usage.prompt_tokens||0,usage.completion_tokens||0,(usage.prompt_tokens||0)+(usage.completion_tokens||0)*2,now());
  await audit(env,tenant,'system','model.connection_verified',modelName,{latency_ms:Date.now()-start});
  return json({ok:true,model:modelName,latency_ms:Date.now()-start,usage:{input_tokens:usage.prompt_tokens||0,output_tokens:usage.completion_tokens||0}});
 }
 if(path==='/api/state' &&method==='GET'){
  if(!factory)return json({registered:false,user:{email:request.headers.get('oai-authenticated-user-email')||''},agents:AGENTS,plans:PLANS,capabilities:capabilities(env),local_mode:env.LOCAL_DEV_MODE==='true',intel});
  await run(env,"UPDATE jobs SET status='blocked',error=?,lease_until=NULL,updated_at=? WHERE tenant=? AND status='running' AND updated_at<? AND kind!='send'",'任务执行连接已中断或超过3分钟。请重试；已完成的资料和方案不会删除。',now(),tenant,new Date(Date.now()-180000).toISOString());
  const rows=await query(env,'SELECT * FROM records WHERE tenant=? ORDER BY created_at DESC LIMIT 1500',tenant),data={};for(const k of KINDS)data[k]=[];for(const r of rows)(data[r.kind]||=[]).push({...r,data:JSON.parse(r.data)});
  const [jobs,logs,usage,channels,payments,subscription]=await Promise.all([
   query(env,'SELECT id,agent,kind,status,attempts,error,output,created_at,updated_at FROM jobs WHERE tenant=? ORDER BY created_at DESC LIMIT 100',tenant),
   query(env,'SELECT * FROM audit WHERE tenant=? ORDER BY created_at DESC LIMIT 150',tenant),
   query(env,'SELECT agent,SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens,SUM(cost_micros) AS cost_micros FROM usage WHERE tenant=? GROUP BY agent',tenant),
   query(env,'SELECT id,channel,account_id,health,last_webhook_at FROM channels WHERE tenant=?',tenant),
   query(env,'SELECT * FROM payment_orders WHERE tenant=? ORDER BY created_at DESC LIMIT 30',tenant),
   one(env,'SELECT * FROM subscriptions WHERE tenant=?',tenant)]);
  const notifications=[];
  const start=new Date(Date.now()+8*3600000).toISOString().slice(0,7)+'-01';
  const monthCost=await one(env,'SELECT COALESCE(SUM(cost_micros),0) AS value FROM usage WHERE tenant=? AND created_at>=?',tenant,subscription?start:'1970-01-01');
  const budget=subscription?PLANS[subscription.plan].cap:15;
  if(monthCost.value>=budget*800000)notifications.push({type:'budget',message:'模型用量已达到预算的 '+Math.floor(monthCost.value/(budget*10000))+'%，请检查用量与任务安排。'});
  if(subscription&&Date.parse(subscription.expires_at)-Date.now()<3*86400000)notifications.push({type:'renewal',message:Date.parse(subscription.expires_at)>Date.now()?'团队将在3天内到期，请按需要续费。':'订阅已到期，团队已暂停执行，历史资料仍可查看。'});
  const overdue=jobs.filter(j=>j.kind==='reply'&&['pending','running'].includes(j.status)&&Date.now()-Date.parse(j.created_at)>180000);
  if(overdue.length)notifications.push({type:'sla',message:overdue.length+' 条询盘首次回复已超过3分钟，请检查卡点。'});
  return json({registered:true,factory,notifications,user:{email:request.headers.get('oai-authenticated-user-email')||''},agents:AGENTS,plans:PLANS,data,jobs,logs,usage,channels,payments,subscription,entitled:!!await active(env,tenant),capabilities:capabilities(env),local_mode:env.LOCAL_DEV_MODE==='true',intel});
 }
 if(!factory)fail('请先建立工厂工作区',409);
 const kick=()=>{if(env.LOCAL_DEV_MODE==='true')ctx.waitUntil(drain(env,tenant,send,{maxJobs:1}));};
 if(path==='/api/documents'&&method==='POST'){
  if(!b.text?.trim()||b.text.length>200000)fail('请提供可读取的文字，最多 20 万字；扫描件请提供文字版。');
  if((await records(env,tenant,'document')).length>=20)fail('当前最多支持 20 份文件，可联系管理员扩容。');
  const id=uid();let storage_key=null;
  if(b.file_base64){const bytes=Uint8Array.from(atob(b.file_base64),c=>c.charCodeAt(0));if(bytes.length>15*1024*1024)fail('单文件最多 15 MB');storage_key='documents/'+tenant+'/'+id;await env.BUCKET.put(storage_key,bytes,{httpMetadata:{contentType:b.mime||'application/octet-stream'}});}
  await put(env,tenant,'document',{name:(b.name||'官网文字').slice(0,180),text:b.text,storage_key,mime:b.mime,parsed:false},id);
  await audit(env,tenant,'boss','document.uploaded',id,{name:b.name});const job=await enqueue(env,tenant,'clerk','parse',{document_id:id});kick();return json({id,job});
 }
 if(path==='/api/file'&&method==='GET'){
  const d=await record(env,tenant,url.searchParams.get('id'));if(!d||d.kind!=='document'||!d.data.storage_key)fail('文件不存在',404);const file=await env.BUCKET.get(d.data.storage_key);if(!file)fail('文件不存在',404);return new Response(file.body,{headers:{'Content-Type':d.data.mime||'application/octet-stream','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(d.data.name),'Cache-Control':'no-store'}});
 }
 if(path==='/api/facts/confirm'&&method==='POST'){
  const ids=b.ids||[];if(!ids.length)fail('请选择需要确认的事实');
  for(const id of ids){const f=await record(env,tenant,id);if(!f||f.kind!=='fact'||f.data.status!=='pending')fail('事实状态已改变，请刷新后确认');if(f.data.conflict&&!b.resolve_conflicts)fail('存在来源冲突，请先逐条确认冲突事实');
   const conflicts=(await records(env,tenant,'fact')).filter(x=>x.id!==id&&x.data.field===f.data.field&&x.data.status==='confirmed');
   for(const old of conflicts)await put(env,tenant,'fact',{...old.data,status:'superseded'},old.id);
   await put(env,tenant,'fact',{...f.data,status:'confirmed',confirmed_at:now()},id);await audit(env,tenant,'boss','gate.1.fact_confirmed',id,{source_id:f.data.source_id});}
  return json({ok:true});
 }
 if(path==='/api/facts/add'&&method==='POST'){
  if(!b.field?.trim()||!b.value?.trim())fail('请填写字段和事实内容');const source=await put(env,tenant,'document',{name:'老板补充说明',text:b.value,parsed:true,gaps:[]});
  const previous=(await records(env,tenant,'fact')).filter(x=>x.data.field===b.field&&x.data.status==='confirmed');
  const id=await put(env,tenant,'fact',{field:b.field,value:b.value,evidence:b.value,source_id:source,source_name:'老板补充说明',status:'pending',version:previous.length+1,conflict:previous.length>0});await audit(env,tenant,'boss','fact.proposed',id);return json({id});
 }
 if(path==='/api/strategy'&&method==='POST'){if(!env.MIMO_API_KEY)fail('MiMo 密钥尚未配置，请先在“我的”中检查连接。',503);if(!(await records(env,tenant,'fact')).some(f=>f.data.status==='confirmed'))fail('请先在商品资料中确认至少一条事实，再生成方案。',409);const job=await enqueue(env,tenant,'manager','strategy',b);kick();return json({job});}
 if(path==='/api/strategy/approve'&&method==='POST'){
  const s=await record(env,tenant,b.id);if(!s||s.kind!=='strategy'||s.data.status!=='pending')fail('方案不存在或已确认');
  const target=Number(b.target??s.data.target);if(!Number.isSafeInteger(target)||target<1||target>10000)fail('询盘目标应在 1 到 10000 之间');
  for(const old of await records(env,tenant,'strategy'))if(old.data.status==='approved')await put(env,tenant,'strategy',{...old.data,status:'superseded'},old.id);
  await put(env,tenant,'strategy',{...s.data,target,status:'approved',approved_at:now(),cadences:[{kind:'report',period:'daily',time:'09:00 Asia/Shanghai'},{kind:'report',period:'weekly',time:'Monday 09:00 Asia/Shanghai'},{kind:'content',period:'weekly',time:'Mon/Wed/Fri 10:00 Asia/Shanghai'}]},s.id);await audit(env,tenant,'boss','gate.0.strategy_approved',s.id,{target});return json({ok:true});
 }
 if(path==='/api/chat'&&method==='POST'){
  if(!b.text?.trim()||b.text.length>5000)fail('请输入问题（最多 5000 字）');
  const agent=AGENTS.some(a=>a.id===b.agent)?b.agent:'manager';
  await put(env,tenant,'chat',{role:'boss',text:b.text,agent});
  const context={question:b.text,agent,strategies:(await records(env,tenant,'strategy')).map(s=>s.data),recent_jobs:await query(env,'SELECT agent,kind,status,error FROM jobs WHERE tenant=? ORDER BY created_at DESC LIMIT 10',tenant)};
  const out=await model(env,tenant,agent,'chat',context);await put(env,tenant,'chat',{role:agent,text:out.text,source_ids:out.source_ids||[]});return json(out);
 }
 if(path==='/api/manager/run'&&method==='POST'){const out=await routeGaps(env,tenant);kick();return json(out);}
 if(path==='/api/jobs/run'&&method==='POST'){const result=await drain(env,tenant,send,{maxJobs:1});return json({ok:true,...result});}
 if(path==='/api/jobs/retry'&&method==='POST'){
  const j=await one(env,'SELECT * FROM jobs WHERE id=? AND tenant=?',b.id,tenant);if(!j||j.status!=='blocked')fail('只有异常工单可以重试');
  await run(env,"UPDATE jobs SET status='pending',attempts=0,available_at=?,updated_at=? WHERE id=?",now(),now(),b.id);await audit(env,tenant,'boss','ticket.retried',b.id);kick();return json({ok:true});
 }
 if(path==='/api/task'&&method==='POST'){
  if(!await active(env,tenant))fail('请先开通团队',402);if(!['content','report'].includes(b.kind))fail('任务类型无效');
  const job=await enqueue(env,tenant,b.kind==='content'?'operations':'manager',b.kind,{period:b.period||'daily',topic:b.topic||''});kick();return json({job});
 }
 if(path==='/api/inbox/import'&&method==='POST'){
  if(!b.name?.trim()||!b.text?.trim()||b.text.length>10000)fail('请输入客户名称和询盘内容');
  const out=await ingest(env,tenant,{channel:['whatsapp','facebook','email'].includes(b.channel)?b.channel:'whatsapp',external_id:'manual-'+uid(),name:b.name,text:b.text,event_id:uid(),origin:b.simulation===true?'simulation':'manual'});kick();return json(out);
 }
 if(path==='/api/prices'&&method==='POST'){
  if(!b.name?.trim()||!b.keywords?.trim())fail('请填写规则名称与匹配关键词');
  const facts=(await records(env,tenant,'fact')).filter(f=>f.data.status==='confirmed');if(!facts.some(f=>f.id===b.product_fact_id)||!facts.some(f=>f.id===b.lead_fact_id))fail('请引用已确认的产品与交期事实');
  const checked=quoteCalc({...b,quantity:1});if(!checked.pass)fail('售价低于设定的毛利底线，无法启用规则');
  const moq=Number(b.moq);if(!Number.isSafeInteger(moq)||moq<1)fail('起订量必须为正整数');
  const id=await put(env,tenant,'price_profile',{name:b.name,keywords:b.keywords,product_fact_id:b.product_fact_id,lead_fact_id:b.lead_fact_id,unit_cost_fen:checked.unit_cost_fen,unit_price_fen:checked.unit_price_fen,floor_bps:checked.floor_bps,currency:checked.currency,moq,terms:String(b.terms||'').slice(0,1000),confirmed_at:now()});await audit(env,tenant,'boss','price_profile.confirmed',id);return json({id});
 }
 if(path==='/api/quote'&&method==='POST'){
  if(!await active(env,tenant))fail('请先开通团队',402);const c=await record(env,tenant,b.customer_id);if(!c||c.kind!=='customer')fail('请选择客户');
  const facts=(await records(env,tenant,'fact')).filter(f=>f.data.status==='confirmed');const f=facts.find(x=>x.id===b.product_fact_id);if(!f)fail('请选择已确认的产品事实');
  const calculation=quoteCalc(b);const leadFact=facts.find(x=>x.id===b.lead_fact_id);if(!leadFact)fail('报价需引用已确认的交期事实，请先补充。');
  const leadText=leadFact.data.value;
  const previous=(await records(env,tenant,'quote')).filter(q=>q.data.customer_id===c.id);
  const text=`Quotation v${previous.length+1}\n${f.data.value}\nQuantity: ${calculation.quantity}\nUnit price: ${(calculation.unit_price_fen/100).toFixed(2)} ${calculation.currency}\nTotal: ${(calculation.total_fen/100).toFixed(2)} ${calculation.currency}\nLead time: ${leadText}\nTerms: ${String(b.terms||'Subject to buyer and seller confirmation. Import duties and taxes excluded.').slice(0,1000)}`;
  const id=await put(env,tenant,'quote',{customer_id:c.id,calculation,text,source_ids:[f.id,leadFact.id],terms:b.terms||'',version:previous.length+1,finance_pass:calculation.pass,legal_pass:false,status:calculation.pass?'reviewing':'blocked',boss_approved:false});
  await audit(env,tenant,'finance','price.calculated',id,{...calculation});
  if(calculation.pass){await enqueue(env,tenant,'legal','review_quote',{quote_id:id});kick();}return json({id,calculation});
 }
 if(path==='/api/approve'&&method==='POST'){
  const r=await record(env,tenant,b.id);if(!r||!['content','quote','outbox'].includes(r.kind))fail('待批项不存在');
  if(r.data.status!=='pending_boss')fail('此项目尚未通过审查或已经批准，请刷新后查看。');
  if(!r.data.legal_pass||(r.kind==='quote'&&!r.data.finance_pass))fail('审批钥匙不齐全，不能批准');
  await put(env,tenant,r.kind,{...r.data,boss_approved:true,approved_at:now(),status:'approved'},r.id);await audit(env,tenant,'boss',r.kind==='quote'?'gate.3.quote_approved':'gate.2.outbound_approved',r.id);
  if(r.kind==='quote'){
   const c=await record(env,tenant,r.data.customer_id);const out=await put(env,tenant,'outbox',{...r.data,type:'quote',channel:c.data.channel,agent:'sales',quote_id:r.id,status:'ready'});
   if(c.data.origin==='live'){await enqueue(env,tenant,'sales','send',{outbox_id:out});kick();}
  }else if(r.kind==='outbox'){await enqueue(env,tenant,r.data.agent||'service','send',{outbox_id:r.id});kick();}
  return json({ok:true});
 }
 if(path==='/api/content/published'&&method==='POST'){
  const r=await record(env,tenant,b.id);if(!r||r.kind!=='content'||r.data.status!=='approved')fail('内容须先经批准');
  if(!/^https:\/\/(www\.)?facebook\.com\//.test(b.url||''))fail('请填写真实 Facebook 帖子链接');
  await put(env,tenant,'content',{...r.data,status:'published',published_url:b.url,published_at:now()},r.id);await audit(env,tenant,'boss','content.publication_recorded',r.id,{url:b.url});return json({ok:true});
 }
 if(path==='/api/order'&&method==='POST'){
  const q=await record(env,tenant,b.quote_id);if(!q||q.kind!=='quote'||!q.data.boss_approved)fail('请先批准报价');
  if(!b.buyer_confirmation?.trim())fail('请记录买家确认内容或凭证编号');
  if((await records(env,tenant,'order')).some(o=>o.data.quote_id===q.id))fail('该报价已有订单',409);
  const customer=await record(env,tenant,q.data.customer_id);
  const id=await put(env,tenant,'order',{origin:customer?.data.origin||'manual',quote_id:q.id,customer_id:q.data.customer_id,total_fen:q.data.calculation.total_fen,currency:q.data.calculation.currency,status:'confirmed',buyer_confirmation:b.buyer_confirmation,confirmed_at:now(),timeline:[{status:'confirmed',note:b.buyer_confirmation,at:now(),actor:'boss'}]});await audit(env,tenant,'boss','gate.4.order_confirmed',id,{quote_id:q.id});return json({id});
 }
 if(path==='/api/order/update'&&method==='POST'){
  const o=await record(env,tenant,b.id);if(!o||o.kind!=='order')fail('订单不存在');if(!['contract_signed','deposit_received','production','balance_received','shipped','completed'].includes(b.status)||!b.note?.trim())fail('请填写状态与凭证／说明');
  await put(env,tenant,'order',{...o.data,status:b.status,timeline:[...o.data.timeline,{status:b.status,note:b.note,at:now(),actor:'boss'}]},o.id);await audit(env,tenant,'boss','order.progress_recorded',o.id,{status:b.status,note:b.note});return json({ok:true});
 }
 if(path==='/api/channels/connect'&&method==='POST')return json(await (b.channel==='email'?connectEmail(env,tenant,b):connect(env,tenant,b)));
 if(path==='/api/channels/disconnect'&&method==='POST'){
  const c=await one(env,'SELECT * FROM channels WHERE tenant=? AND id=?',tenant,b.id);if(!c)fail('渠道不存在');await run(env,"UPDATE channels SET health='disconnected' WHERE tenant=? AND id=?",tenant,b.id);await env.BUCKET.delete(c.token_ref);await audit(env,tenant,'boss','channel.disconnected',b.id);return json({ok:true});
 }
 if(path==='/api/checkout'&&method==='POST')return json(await checkout(env,tenant,b,url.origin));
 if(path==='/api/invoice'&&method==='POST'){
  const p=await one(env,"SELECT * FROM payment_orders WHERE id=? AND tenant=? AND status='paid'",b.payment_id,tenant);if(!p)fail('仅已支付订单可申请开票');if(!b.title?.trim()||!b.tax_id?.trim()||!b.email?.includes('@'))fail('请填写抬头、税号和接收邮箱');const id=await put(env,tenant,'invoice',{...b,status:'requested'});await audit(env,tenant,'boss','invoice.requested',id);return json({id});
 }
 if(path==='/api/export'&&method==='GET'){
  const [logs,rows,jobs]=await Promise.all([query(env,'SELECT * FROM audit WHERE tenant=? ORDER BY created_at',tenant),query(env,'SELECT * FROM records WHERE tenant=? ORDER BY created_at',tenant),query(env,'SELECT id,agent,kind,status,attempts,error,output,created_at,updated_at FROM jobs WHERE tenant=? ORDER BY created_at',tenant)]);
  const payload={exported_at:now(),factory,records:rows.map(r=>({...r,data:JSON.parse(r.data)})),logs,jobs};return new Response(JSON.stringify(payload,null,2),{headers:{'Content-Type':'application/json','Content-Disposition':'attachment; filename="tradecrew-audit.json"','Cache-Control':'no-store'}});
 }
 fail('接口不存在',404);
}
function capabilities(env){return {mimo:!!env.MIMO_API_KEY,payment:!!(env.PAYMENT_BRIDGE_URL&&env.PAYMENT_BRIDGE_SECRET),meta:!!(env.META_APP_SECRET&&env.META_VERIFY_TOKEN&&env.TOKEN_ENCRYPTION_KEY),scheduler:env.SCHEDULER_ENABLED==='true'};}
async function schedule(request,env,ctx){
 const raw=await request.text(),ts=request.headers.get('x-trade-timestamp');if(!env.SCHEDULER_SECRET||!ts||Math.abs(Date.now()-Number(ts))>300000||!safeEqual(request.headers.get('x-trade-signature'),await hmac(env.SCHEDULER_SECRET,ts+'.'+raw)))return json({error:'Invalid signature'},401);
 return json(await tick(env,ctx));
}
export default {async fetch(request,env,ctx){try{
 const path=new URL(request.url).pathname;
 if(path==='/webhooks/email')return await emailWebhook(request,env,ctx);
 if(path==='/webhooks/meta')return await webhook(env,request,ctx,drain);
 if(path==='/webhooks/payment')return await paymentWebhook(env,request);
 if(path==='/api/scheduler')return await schedule(request,env,ctx);
 if(path.startsWith('/api/'))return await api(request,env,ctx);
 const a=assets[path]||(path.startsWith('/assets/')?null:assets['/index.html']);if(!a)return new Response('Not found',{status:404});
 return new Response(Uint8Array.from(atob(a.b),c=>c.charCodeAt(0)),{headers:{'Content-Type':a.type,'Cache-Control':path.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'self' https://chatgpt.com https://*.chatgpt.com"}});
 }catch(e){return json({error:e.message||'服务暂时不可用'},e.status||500);}},async scheduled(event,env,ctx){await tick(env,ctx);}};
