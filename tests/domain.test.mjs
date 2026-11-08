import test from 'node:test';
import assert from 'node:assert/strict';
import {quoteCalc,gatewayCheck,paymentAmount,validateStrategy} from '../server/domain.mjs';
test('报价用整数分计算，毛利低于底线即拒绝',()=>{
 const q=quoteCalc({quantity:1800,unit_cost_fen:380,unit_price_fen:468,freight_fen:600,floor_bps:1500});assert.equal(q.total_fen,843000);assert.equal(q.margin_bps,1879);assert.equal(q.pass,true);
 assert.equal(quoteCalc({quantity:1,unit_cost_fen:90,unit_price_fen:100,floor_bps:1500}).pass,false);
 assert.throws(()=>quoteCalc({quantity:1.5,unit_cost_fen:100,unit_price_fen:200}));
});
const context={facts:[{id:'f1',data:{status:'confirmed'}}],customer:{external_id:'real-user',window_expires_at:new Date(Date.now()+60000).toISOString()}};
test('网关拦截未批准报价，双钥匙与老板不可缺少',()=>{
 const o={text:'Quoted product',type:'quote',channel:'whatsapp',source_ids:['f1'],calculation:{calculated_by:'price.calc:v1',pass:true},legal_pass:true,finance_pass:true};
 assert.equal(gatewayCheck(o,context).pass,false);assert.equal(gatewayCheck({...o,boss_approved:true},context).pass,true);
 assert.equal(gatewayCheck({...o,boss_approved:true,finance_pass:false},context).pass,false);
});
test('网关拦截退订、过期窗口和未确认事实',()=>{
 const o={type:'first_reply',text:'Hello',channel:'whatsapp',source_ids:['f1']};assert.equal(gatewayCheck(o,context).pass,true);
 assert.equal(gatewayCheck(o,{...context,customer:{...context.customer,opted_out:true}}).pass,false);
 assert.equal(gatewayCheck(o,{...context,customer:{...context.customer,window_expires_at:'2020-01-01'}}).pass,false);
 assert.equal(gatewayCheck({...o,source_ids:['unknown']},context).pass,false);
});
test('套餐金额来自服务端，试用抵扣仅限有效试用转月付',()=>{
 const s={plan:'trial',expires_at:new Date(Date.now()+86400000).toISOString()};assert.equal(paymentAmount('monthly',s,true),30000);assert.equal(paymentAmount('annual',s,true),399000);assert.equal(paymentAmount('monthly',s,false),39900);assert.throws(()=>paymentAmount('custom',null,false));
});
test('C 级情报不可标为事实，未知编号与过期来源被拒绝',()=>{
 const base={summary:'方向',hypotheses:[],insights:[{kind:'fact',statement:'测试来源陈述',intel_ids:['C1']}]};
 assert.throws(()=>validateStrategy(base,{inquiries:20},[{id:'C1',confidence:'C',expires_at:'2028-01-01'}]));
 const s=validateStrategy({...base,insights:[{kind:'clue',statement:'测试来源线索',intel_ids:['C1']}]},{inquiries:31},[{id:'C1',confidence:'C',expires_at:'2028-01-01'}]);assert.equal(s.target,31);assert.equal(s.sample_target,20);
});
