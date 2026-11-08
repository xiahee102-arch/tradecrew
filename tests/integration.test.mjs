import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
let mf,db;
const secret='integration-fixture-secret';
async function setup(){
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'dist/server/index.js',compatibilityDate:'2026-01-01',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['BUCKET'],bindings:{MIMO_API_KEY:'test-fixture-not-real',META_APP_SECRET:secret,META_VERIFY_TOKEN:'verify-fixture',TOKEN_ENCRYPTION_KEY:'vault-fixture',PAYMENT_BRIDGE_SECRET:secret,PAYMENT_BRIDGE_URL:'https://payments.test/checkout'},outboundService:async req=>{
  const url=new URL(req.url);
  if(url.hostname==='payments.test')return Response.json({checkout_url:'https://payments.test/pay/fixture'});
  if(url.hostname==='api.xiaomimimo.com'){
   const b=await req.json(),system=b.messages[0].content;let content;
   if(b.messages.at(-1).content.includes('连接成功'))content={ok:true,message:'连接成功'};
   else if(system.includes('source_text'))content={facts:[{field:'产品',value:'316 glass clamps',evidence:'316 glass clamps'},{field:'交期',value:'35 days',evidence:'35 days'}],gaps:['材质证明文件待补充']};
   else if(system.includes('生成出海方案'))content={summary:'先验证马来西亚三个区域的询盘',insights:[{kind:'fact',statement:'雪兰莪与柔佛新盘集中',intel_ids:['DEM-02']}],hypotheses:[{code:'H3',text:'先试三个州',evidence_ids:['DEM-02'],validation:'首批20条询盘'}],markets:['马来西亚'],positioning:'规格透明',channel_strategy:['WhatsApp 承接询盘'],content_plan:['每周3条内容'],risks:['价格暂无可靠数据'],boss_actions:['上传材质证明']};
   else if(system.includes('处理最新买家消息')){const context=JSON.parse(b.messages[1].content);assert.ok(context.confirmed_facts.every(f=>!('source_id' in f)));const m=context.input.messages.at(-1)?.text||'';content={text:'I am the factory AI assistant. Thank you. We will prepare your quotation for review.',source_ids:context.confirmed_facts.slice(0,1).map(f=>f.id),requirements:{product:'316 glass clamps',material:'316',quantity:m.includes('1800')?1800:null,port:'Penang'},missing:[],escalation:null,intent:'inquiry'};}
   else if(system.includes('做资料与条款审查'))content={pass:true,issues:[],source_ids:[],note:'测试夹具审查通过'};
   else if(system.includes('起草一篇 Facebook'))content={title:'Product specifications',text:'Ask our team about product specifications.',source_ids:[],notes:[]};
   else content={text:'测试夹具输出',title:'经营简报',summary:'尚无足够真实数据',findings:[],blockers:[],next_actions:[],hypothesis_updates:[]};
   return Response.json({choices:[{message:{content:JSON.stringify(content)}}],usage:{prompt_tokens:100,completion_tokens:100}});
  }
  if(url.hostname==='api.resend.com'){
   if(url.pathname==='/domains')return Response.json({data:[{name:'fixture.test',status:'verified'}]});
   if(url.pathname.startsWith('/emails/receiving/'))return Response.json({from:'Buyer <buyer@example.test>',to:['inquiry@fixture.test'],subject:'Catalog inquiry',message_id:'<fixture-thread@example.test>',text:'Hello, please send your catalog.'});
   if(url.pathname==='/emails')return Response.json({id:'resend-sent-fixture'});
  }
  if(url.hostname==='graph.facebook.com')return Response.json({id:'123456789',display_phone_number:'+60123456789',verified_name:'Fixture Factory'});
  return new Response('No fixture',{status:404});
 }}));
 db=await mf.getD1Database('DB');const sql=await readFile('drizzle/0000_init.sql','utf8');for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
}
async function req(path,body,user='alice'){
 const r=await mf.dispatchFetch('https://trade.test'+path,{method:body===undefined?'GET':'POST',headers:{...(user?{'oai-authenticated-user-id':user,'oai-authenticated-user-email':user+'@example.test'}:{}),...(body===undefined?{}:{'Content-Type':'application/json','Origin':'https://trade.test'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};
}
async function settle(){for(let i=0;i<35;i++){const jobs=await db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending','running')").first();if(!jobs.n)return;await req('/api/jobs/run',{});await new Promise(r=>setTimeout(r,50));}throw Error('Jobs did not settle');}
function signed(body){const raw=JSON.stringify(body),ts=String(Date.now());return {raw,headers:{'Content-Type':'application/json','x-trade-timestamp':ts,'x-trade-signature':createHmac('sha256',secret).update(ts+'.'+raw).digest('hex')}};}
await test('持久化业务链路与信任边界（供应商使用隔离测试夹具）',async t=>{
 await setup();t.after(()=>mf.dispose());
 await t.test('未登录接口拒绝；两个工厂的数据隔离',async()=>{
  assert.equal((await req('/api/state',undefined,null)).status,401);
  assert.equal((await req('/api/register',{factory:'测试工厂A',category:'楼梯五金'})).status,200);
  assert.equal((await req('/api/register',{factory:'测试工厂B',category:'建材'},'bob')).status,200);
  const a=await req('/api/state');assert.equal(a.data.factory.factory,'测试工厂A');assert.equal((await req('/api/state',undefined,'bob')).data.factory.factory,'测试工厂B');
 });
 await t.test('上传→文员提取→待确认，未经确认不可制定方案',async()=>{
  assert.equal((await req('/api/documents',{name:'fixture.txt',text:'We manufacture 316 glass clamps. Lead time 35 days.'})).status,200);await settle();
  let a=await req('/api/state');assert.equal(a.data.data.fact.length,2);assert.ok(a.data.data.fact.every(f=>f.data.status==='pending'));
  assert.equal((await req('/api/strategy',{market:'马来西亚',inquiries:20})).status,409);a=await req('/api/state');assert.equal(a.data.jobs.filter(j=>j.kind==='strategy').length,0);
  assert.equal((await req('/api/facts/confirm',{ids:[a.data.data.fact[0].id]},'bob')).status,400);
  assert.equal((await req('/api/facts/confirm',{ids:a.data.data.fact.map(f=>f.id)})).status,200);
 });
 await t.test('市场方案带真实情报编号，经老板确认方可付费开通',async()=>{
  await req('/api/strategy',{market:'马来西亚',inquiries:33});await settle();const a=await req('/api/state'),s=a.data.data.strategy[0];assert.equal(s.data.target,33);assert.equal(s.data.status,'pending');
  assert.equal((await req('/api/checkout',{plan:'trial',method:'wechat'})).status,400);
  assert.equal((await req('/api/strategy/approve',{id:s.id,target:33})).status,200);
 });
 await t.test('连接检查调用真实后端路径且不会向前端返回密钥',async()=>{
  const r=await req('/api/model/check',{});assert.equal(r.status,200);assert.equal(r.data.ok,true);assert.equal(r.data.model,'mimo-v2.6-flash');assert.ok(!JSON.stringify(r.data).includes('test-fixture-not-real'));
 });
 await t.test('进程中断的任务变成可重试失败，不能永久显示执行中',async()=>{
  const timestamp=new Date(Date.now()-240000).toISOString();await db.prepare('INSERT INTO jobs (id,tenant,agent,kind,input,status,attempts,available_at,lease_until,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind('interrupted-job','alice','manager','strategy','{}','running',1,timestamp,new Date(Date.now()+600000).toISOString(),timestamp,timestamp).run();
  const state=await req('/api/state');const job=state.data.jobs.find(j=>j.id==='interrupted-job');assert.equal(job.status,'blocked');assert.match(job.error,/中断|超过/);
 });
 let order;
 await t.test('订单金额由套餐计算，伪造回调不能激活，真实签名回调幂等',async()=>{
  const p=await req('/api/checkout',{plan:'trial',method:'wechat',amount_fen:1});assert.equal(p.status,200);assert.equal(p.data.amount_fen,9900);order=p.data.id;
  const paid={out_trade_no:order,amount_fen:9900,currency:'CNY',method:'wechat',status:'paid',transaction_id:'receipt-fixture'};
  const unsigned=await mf.dispatchFetch('https://trade.test/webhooks/payment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(paid)});assert.equal(unsigned.status,401);
  let b=signed({...paid,amount_fen:1});assert.equal((await mf.dispatchFetch('https://trade.test/webhooks/payment',{method:'POST',headers:b.headers,body:b.raw})).status,400);
  b=signed(paid);assert.equal((await mf.dispatchFetch('https://trade.test/webhooks/payment',{method:'POST',headers:b.headers,body:b.raw})).status,200);
  const exp=(await req('/api/state')).data.subscription.expires_at;
  for(let i=0;i<5;i++){b=signed(paid);await mf.dispatchFetch('https://trade.test/webhooks/payment',{method:'POST',headers:b.headers,body:b.raw});}
  assert.equal((await req('/api/state')).data.subscription.expires_at,exp);assert.equal((await req('/api/state')).data.entitled,true);
  assert.equal((await req('/api/checkout',{plan:'trial',method:'wechat'})).status,400);
 });
 await t.test('需求→程序报价→法务财务→老板批准→订单确认，未经批准不能建单',async()=>{
  const a=(await req('/api/state')).data,facts=a.data.fact,product=facts.find(f=>f.data.field==='产品'),lead=facts.find(f=>f.data.field==='交期');
  assert.equal((await req('/api/prices',{name:'玻璃夹规则',keywords:'glass clamps,316',product_fact_id:product.id,lead_fact_id:lead.id,unit_cost_fen:380,unit_price_fen:468,floor_bps:1500,currency:'USD',moq:100,terms:'FOB Shanghai, 30% deposit'})).status,200);
  const c=await req('/api/inbox/import',{name:'Buyer Fixture',channel:'whatsapp',text:'Need 1800 pcs 316 glass clamps to Penang.'});assert.equal(c.status,200);await settle();
  const b=(await req('/api/state')).data;assert.equal(b.data.quote.length,1);const q=b.data.quote[0];assert.equal(q.data.status,'pending_boss');assert.equal(q.data.finance_pass,true);assert.equal(q.data.legal_pass,true);assert.equal(q.data.calculation.total_fen,842400);
  assert.equal((await req('/api/order',{quote_id:q.id,buyer_confirmation:'Fixture buyer confirmation'})).status,400);
  assert.equal((await req('/api/approve',{id:q.id})).status,200);
  assert.equal((await req('/api/order',{quote_id:q.id,buyer_confirmation:'Fixture buyer confirmation'})).status,200);
  assert.equal((await req('/api/state',undefined,'bob')).data.data.quote.length,0);
 });
 await t.test('Meta 验签、5次重复消息只生成1询盘；退订不可继续发送',async()=>{
  assert.equal((await req('/api/channels/connect',{channel:'whatsapp',account_id:'123456789',token:'fixture-token'})).status,200);
  const payload={object:'whatsapp_business_account',entry:[{id:'business-fixture',changes:[{value:{metadata:{phone_number_id:'123456789'},messages:[{id:'wamid-fixture',from:'6012345678',timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:'Hello, can I get a catalog?'}}]}}]}]},raw=JSON.stringify(payload),sig='sha256='+createHmac('sha256',secret).update(raw).digest('hex');
  const bad=await mf.dispatchFetch('https://trade.test/webhooks/meta',{method:'POST',headers:{'x-hub-signature-256':'bad'},body:raw});assert.equal(bad.status,401);
  for(let i=0;i<5;i++)assert.equal((await mf.dispatchFetch('https://trade.test/webhooks/meta',{method:'POST',headers:{'x-hub-signature-256':sig},body:raw})).status,200);
  await settle();const a=(await req('/api/state')).data;assert.equal(a.data.message.filter(m=>m.data.provider_message_id==='wamid-fixture').length,1);assert.equal(a.data.customer.filter(c=>c.data.origin==='live').length,1);
  payload.entry[0].changes[0].value.messages[0].id='wamid-stop';payload.entry[0].changes[0].value.messages[0].text.body='STOP';const stopRaw=JSON.stringify(payload),stopSig='sha256='+createHmac('sha256',secret).update(stopRaw).digest('hex');
  await mf.dispatchFetch('https://trade.test/webhooks/meta',{method:'POST',headers:{'x-hub-signature-256':stopSig},body:stopRaw});await new Promise(r=>setTimeout(r,80));assert.equal((await req('/api/state')).data.data.customer.find(c=>c.data.origin==='live').data.opted_out,true);
 });
 await t.test('邮件域名验证、Svix签名、原线程收发与重复事件去重',async()=>{
  const signing=Buffer.from('email-signing-fixture').toString('base64'),connected=await req('/api/channels/connect',{channel:'email',account_id:'inquiry@fixture.test',token:'resend-fixture-token',webhook_secret:'whsec_'+signing});
  assert.equal(connected.status,200);const emailEvent={type:'email.received',data:{email_id:'email-fixture',message_id:'<fixture-thread@example.test>'}},raw=JSON.stringify(emailEvent),id='svix-fixture-1',ts=String(Math.floor(Date.now()/1000)),signature='v1,'+createHmac('sha256',Buffer.from(signing,'base64')).update(id+'.'+ts+'.'+raw).digest('base64');
  const url='https://trade.test'+connected.data.callback_path;
  assert.equal((await mf.dispatchFetch(url,{method:'POST',headers:{'svix-id':id,'svix-timestamp':ts,'svix-signature':'v1,bad'},body:raw})).status,401);
  for(let i=0;i<3;i++)assert.equal((await mf.dispatchFetch(url,{method:'POST',headers:{'svix-id':id,'svix-timestamp':ts,'svix-signature':signature},body:raw})).status,200);
  await settle();const s=(await req('/api/state')).data;assert.equal(s.data.message.filter(m=>m.data.provider_message_id==='email-fixture').length,1);
  const c=s.data.customer.find(c=>c.data.channel==='email');assert.equal(c.data.email_message_id,'<fixture-thread@example.test>');
  assert.equal(s.data.message.filter(m=>m.data.customer_id===c.id&&m.data.direction==='out').length,1);
 });
 await t.test('同源保护与已过期订阅拦截，构建资源可被Worker正确提供',async()=>{
  const csrf=await mf.dispatchFetch('https://trade.test/api/facts/add',{method:'POST',headers:{'oai-authenticated-user-id':'alice','Content-Type':'application/json',Origin:'https://evil.test'},body:'{}'});assert.equal(csrf.status,403);
  const html=await mf.dispatchFetch('https://trade.test/');assert.equal(html.status,200);const text=await html.text();assert.ok(text.includes('外贸助手'));assert.ok(text.includes('type="module"'));
  const workerPath=(await import('node:fs/promises')).readdir('dist/client/assets').then(a=>a.find(f=>f.startsWith('pdf.worker')&&f.endsWith('.mjs')));const resource=await mf.dispatchFetch('https://trade.test/assets/'+await workerPath);assert.equal(resource.headers.get('Content-Type'),'text/javascript');
  await db.prepare("UPDATE subscriptions SET expires_at='2020-01-01' WHERE tenant='alice'").run();assert.equal((await req('/api/task',{kind:'content'})).status,402);assert.equal((await req('/api/state')).data.entitled,false);
 });

});
