import {PLANS,paymentAmount} from './domain.mjs';
import {uid,now,one,run,records,audit,json,fail} from './store.js';
import {hmac,safeEqual} from './channels.js';
export async function checkout(env,tenant,body,origin){
 if(!PLANS[body.plan]||!['wechat','alipay'].includes(body.method))fail('套餐或支付方式无效');
 if(!(await records(env,tenant,'strategy')).some(s=>s.data.status==='approved'))fail('请先确认出海战略，再开通团队。');
 if(!env.PAYMENT_BRIDGE_URL||!env.PAYMENT_BRIDGE_SECRET)fail('支付尚未开通。已预留微信／支付宝服务端接口，请联系平台管理员配置商户网关。',503);
 const sub=await one(env,'SELECT * FROM subscriptions WHERE tenant=?',tenant);
 const trial=await one(env,"SELECT id FROM payment_orders WHERE tenant=? AND plan='trial' AND status='paid' LIMIT 1",tenant);
 if(body.plan==='trial'&&trial)fail('试用版仅可购买一次，请选择月付或年付。');
 const id=uid(),amount=paymentAmount(body.plan,sub,!!trial),expires=new Date(Date.now()+1800000).toISOString();
 const request={out_trade_no:id,amount_fen:amount,currency:'CNY',plan_code:body.plan,method:body.method,description:'外贸助手 '+PLANS[body.plan].name,notify_url:env.PAYMENT_NOTIFY_URL||origin+'/webhooks/payment',return_url:origin+'/#account',expires_at:expires};
 await run(env,'INSERT INTO payment_orders (id,tenant,plan,amount_fen,method,status,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)',id,tenant,body.plan,amount,body.method,'creating',expires,now());
 const raw=JSON.stringify(request),ts=String(Date.now());
 try{
  const response=await fetch(env.PAYMENT_BRIDGE_URL,{method:'POST',headers:{'Content-Type':'application/json','X-Trade-Timestamp':ts,'X-Trade-Signature':await hmac(env.PAYMENT_BRIDGE_SECRET,ts+'.'+raw)},body:raw,signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error('商户网关下单失败：HTTP '+response.status);
  const data=await response.json();if(!data.checkout_url||!/^https:\/\//.test(data.checkout_url))throw Error('支付网关必须返回 HTTPS 收银台地址');
  await run(env,"UPDATE payment_orders SET status='pending',checkout_url=? WHERE id=?",data.checkout_url,id);await audit(env,tenant,'billing','payment.created',id,{amount_fen:amount,plan:body.plan,method:body.method});
  return {id,amount_fen:amount,checkout_url:data.checkout_url,expires_at:expires};
 }catch(e){await run(env,"UPDATE payment_orders SET status='failed' WHERE id=?",id);throw e;}
}
export async function paymentWebhook(env,request){
 const raw=await request.text(),ts=request.headers.get('x-trade-timestamp'),signature=request.headers.get('x-trade-signature');
 if(!env.PAYMENT_BRIDGE_SECRET||!ts||Math.abs(Date.now()-Number(ts))>300000||!safeEqual(signature,await hmac(env.PAYMENT_BRIDGE_SECRET,ts+'.'+raw)))return json({error:'Invalid signature'},401);
 const data=JSON.parse(raw),order=await one(env,'SELECT * FROM payment_orders WHERE id=?',data.out_trade_no);
 if(!order||data.status!=='paid'||data.amount_fen!==order.amount_fen||data.currency!=='CNY'||data.method!==order.method||!data.transaction_id)return json({error:'Order validation failed'},400);
 if(order.status==='paid')return json({ok:true,duplicate:true});
 if(!['pending','creating'].includes(order.status))return json({error:'Order cannot be paid'},409);
 const subscription=await one(env,'SELECT * FROM subscriptions WHERE tenant=?',order.tenant);
 const base=subscription&&subscription.plan!=='trial'&&Date.parse(subscription.expires_at)>Date.now()?Date.parse(subscription.expires_at):Date.now();
 const expires=new Date(base+PLANS[order.plan].days*86400000).toISOString(),paid=now(),activation=uid();
 // D1 batch is transactional. Activate only for this unique provider receipt and an unpaid order.
 await env.DB.batch([
  env.DB.prepare("UPDATE payment_orders SET status='paid',provider_ref=?,paid_at=?,activation_id=? WHERE id=? AND status IN ('pending','creating')").bind(data.transaction_id,paid,activation,order.id),
  env.DB.prepare("INSERT INTO subscriptions (tenant,plan,status,expires_at,updated_at) SELECT ?,?,'active',?,? WHERE EXISTS(SELECT 1 FROM payment_orders WHERE id=? AND provider_ref=? AND activation_id=?) ON CONFLICT(tenant) DO UPDATE SET plan=excluded.plan,status='active',expires_at=excluded.expires_at,updated_at=excluded.updated_at").bind(order.tenant,order.plan,expires,paid,order.id,data.transaction_id,activation)
 ]);
 await audit(env,order.tenant,'billing','subscription.activated',order.id,{plan:order.plan,expires_at:expires,transaction_id:data.transaction_id});return json({ok:true});
}
