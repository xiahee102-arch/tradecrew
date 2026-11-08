import {now,uid,run,one,records,put,audit,active,fail} from './store.js';
import {enqueue} from './agents.js';
export async function routeGaps(env,tenant){
 if(!await active(env,tenant))return {skipped:'团队尚未开通'};
 const strategy=(await records(env,tenant,'strategy')).find(s=>s.data.status==='approved');if(!strategy)return {skipped:'缺少已批准战略'};
 const date=new Date(Date.now()+8*3600000).toISOString().slice(0,10),customers=await records(env,tenant,'customer');
 const month=new Date(Date.now()+8*3600000).toISOString().slice(0,7);
 const current=customers.filter(c=>c.data.origin==='live'&&new Date(Date.parse(c.created_at)+8*3600000).toISOString().startsWith(month)).length;
 const target=strategy.data.target,gap=Math.max(0,target-current),goalId='goal:'+strategy.id;
 await put(env,tenant,'goal',{strategy_id:strategy.id,title:'每月有效询盘验证',target,current,gap,unit:'条/月',measurement:'真实接入客户数，暂不自动判断询盘有效性',period:month},goalId);
 if(!gap)return {goal_id:goalId,current,target,gap};
 const key='gap-route:'+tenant+':'+date,claim=await run(env,'INSERT OR IGNORE INTO channel_events VALUES (?,?,?,?,?,?)',key,tenant,'manager','{}','processed',now());if(!claim.meta.changes)return {goal_id:goalId,current,target,gap,already_routed:true};
 const profiles=await records(env,tenant,'price_profile'),facts=await records(env,tenant,'fact');const actions=[];
 if(!profiles.length){const id=await put(env,tenant,'blocker',{title:'报价规则尚未设定',detail:'请在商品资料 → 价格参数中配置成本、售价和交期来源，业务员才能自动处理完整询盘。',goal_id:goalId,status:'open'});actions.push(id);}
 if(!facts.some(f=>f.data.status==='confirmed')){const id=await put(env,tenant,'blocker',{title:'需要老板确认产品事实',detail:'总管不会绕过事实确认关口，请先核对文员草稿。',goal_id:goalId,status:'open'});actions.push(id);}
 else {
  const existing=(await records(env,tenant,'content')).some(c=>c.created_at.startsWith(date)&&['pending','pending_boss','approved'].includes(c.data.status));
  if(!existing){const id=await enqueue(env,tenant,'operations','content',{goal_id:goalId,topic:'根据已批准战略，围绕规格透明与真实产品事实起草内容，为未完成的询盘目标提供下一步素材。'});actions.push(id);}
 }
 await audit(env,tenant,'manager','goal.gap_routed',goalId,{current,target,gap,actions});return {goal_id:goalId,current,target,gap,actions};
}
