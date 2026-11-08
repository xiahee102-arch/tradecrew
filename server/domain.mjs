export const PLANS={trial:{name:'试用版',fen:9900,days:14,inquiries:30,posts:6,cap:30},monthly:{name:'月付版',fen:39900,days:30,inquiries:150,posts:12,cap:120},annual:{name:'年付版',fen:399000,days:365,inquiries:150,posts:12,cap:120}};
export const AGENTS=[
 {id:'manager',name:'总管',tag:'总',role:'战略与调度',goal:'把你的目标，变成团队每天的行动',free:true,model:'pro',tools:['kb.search','goal.propose','ticket.create','report.write']},
 {id:'clerk',name:'文员',tag:'文',role:'事实与资料',goal:'每一条产品事实，都有来源可查',free:true,tools:['doc.parse','kb.propose','customer.update']},
 {id:'service',name:'客服',tag:'客',role:'客户接待',goal:'理解买家需求，只说已确认的事实',tools:['kb.search','requirement.write','outbox.submit']},
 {id:'sales',name:'业务员',tag:'业',role:'报价与跟进',goal:'把有效询盘，一步步推进到成交',tools:['price.calc','quote.draft','outbox.submit']},
 {id:'operations',name:'运营',tag:'运',role:'内容与增长',goal:'用真实内容获客，用询盘验证假设',tools:['content.draft','hypothesis.review','report.write']},
 {id:'legal',name:'法务',tag:'法',role:'条款与风控',goal:'检查每一句对外表达的依据与边界',tools:['kb.search','review.legal']},
 {id:'finance',name:'财务',tag:'财',role:'价格与用量',goal:'程序计算价格，核对毛利与预算',tools:['price.floor_check','review.finance','ledger.read']}
];
export function quoteCalc(p){
 const quantity=Number(p.quantity),cost=Number(p.unit_cost_fen),unit=Number(p.unit_price_fen),floor=Number(p.floor_bps??1500),freight=Number(p.freight_fen??0);
 if(![quantity,cost,unit,floor,freight].every(Number.isSafeInteger)||quantity<1||quantity>1e7||cost<1||unit<1||freight<0||floor<0||floor>=10000)throw Error('请输入有效数量、分为单位的价格和底线参数');
 const total=unit*quantity+freight,totalCost=cost*quantity+freight;
 if(!Number.isSafeInteger(total))throw Error('报价超出计算范围');
 const margin_bps=Math.floor((total-totalCost)*10000/total);
 return {quantity,unit_price_fen:unit,unit_cost_fen:cost,freight_fen:freight,total_fen:total,margin_bps,floor_bps:floor,pass:margin_bps>=floor,currency:p.currency==='CNY'?'CNY':'USD',calculated_by:'price.calc:v1',lead_days:Number(p.lead_days)||null};
}
export function gatewayCheck(o,{facts=[],customer={},now=Date.now()}={}){
 const reasons=[];
 if(customer.opted_out)reasons.push('买家已退订');
 if(!o.text?.trim())reasons.push('内容为空');
 if(o.channel==='whatsapp'&&(!customer.window_expires_at||Date.parse(customer.window_expires_at)<now))reasons.push('WhatsApp 24 小时窗口已关闭，请等待买家重新联系');
 if(o.channel==='facebook'&&(!customer.window_expires_at||Date.parse(customer.window_expires_at)<now))reasons.push('Messenger 24 小时窗口已关闭');
 if(!customer.external_id)reasons.push('缺少真实渠道收件人');
 if((o.source_ids||[]).some(id=>!facts.some(f=>f.id===id&&f.data.status==='confirmed')))reasons.push('引用了未确认或不存在的事实');
 if(o.channel==='email'&&!customer.email_message_id)reasons.push('缺少原始邮件线程，不允许主动联系');
 if(o.type==='quote'){
  if(!o.calculation||o.calculation.calculated_by!=='price.calc:v1'||!o.calculation.pass)reasons.push('价格程序未通过毛利底线校验');
  if(!o.legal_pass||!o.finance_pass)reasons.push('法务与财务双钥匙未齐全');
 }
 if(!['first_reply','clarification'].includes(o.type)&&!o.boss_approved)reasons.push('尚未获得老板批准');
 if(/guaranteed profit|100% safe|免认证|保证不生锈|永不生锈/i.test(o.text))reasons.push('命中禁止承诺规则');
 return {pass:reasons.length===0,reasons};
}
export function paymentAmount(plan,subscription,trialPaid){
 if(!PLANS[plan])throw Error('未知套餐');
 const credit=plan==='monthly'&&subscription?.plan==='trial'&&Date.parse(subscription.expires_at)>Date.now()&&trialPaid?9900:0;
 return PLANS[plan].fen-credit;
}
export function validateStrategy(s,answers,intel,facts=[]){
 if(typeof s.summary!=='string'||!Array.isArray(s.insights)||!Array.isArray(s.hypotheses))throw Error('方案结构不完整');
 for(const k of ['markets','channel_strategy','content_plan','risks','boss_actions'])s[k]=Array.isArray(s[k])?s[k].map(x=>typeof x==='string'?x:JSON.stringify(x)):[];
 const factoryIds=new Set(facts.flatMap(f=>[f.id,f.data?.source_id]).filter(Boolean));
 const marketIds=new Set(intel.map(e=>e.id));
 const splitReferences=(references=[])=>{
  if(!Array.isArray(references))throw Error('来源编号必须为数组');
  const market=[],factory=[];
  for(const id of references){if(marketIds.has(id))market.push(id);else if(factoryIds.has(id))factory.push(id);else throw Error('来源编号不存在：'+id);}
  return {market,factory};
 };
 for(const h of s.hypotheses){
  if(typeof h.text!=='string'||typeof h.validation!=='string')throw Error('假设缺少文字或验证标准');
  const refs=splitReferences(h.evidence_ids||[]),source=splitReferences(h.source_ids||[]);
  h.evidence_ids=[...new Set([...refs.market,...source.market])];h.source_ids=[...new Set([...refs.factory,...source.factory])];
 }
 for(const i of s.insights){
  if(typeof i.statement!=='string')throw Error('市场洞察缺少文字');if(i.kind==='gap')continue;
  const refs=splitReferences(i.intel_ids||[]),source=splitReferences(i.source_ids||[]);
  i.intel_ids=[...new Set([...refs.market,...source.market])];i.source_ids=[...new Set([...refs.factory,...source.factory])];
  if(!i.intel_ids.length){if(!i.source_ids.length)throw Error('市场洞察缺少来源编号');i.kind='clue';i.evidence_scope='factory';continue;}
  for(const id of i.intel_ids){const e=intel.find(x=>x.id===id);if(Date.parse(e.expires_at)<Date.now())throw Error('市场来源已过期：'+id);if(e.confidence.startsWith('C')&&i.kind==='fact')throw Error('C 级来源只能作为线索或假设');}
 }

 s.target=Number(answers.inquiries)||20;s.sample_target=20;s.expectation='无法用现有数据验证询盘转化率；先用首批 20 条真实询盘校准。';
 return s;
}
export function normalizeRequirement(value){
 const input=Array.isArray(value)?(value.length===1?value[0]:{}):(value||{}),out={...input};
 for(const field of ['product','material','port','delivery','payment']){const v=out[field];if(v&&typeof v==='object')out[field]=typeof v.value==='string'?v.value:typeof v.name==='string'?v.name:null;}
 const raw=out.quantity&&typeof out.quantity==='object'?out.quantity.value:out.quantity;
 if(typeof raw==='number'&&Number.isSafeInteger(raw)&&raw>0)out.quantity=raw;
 else if(typeof raw==='string'){
  const m=raw.trim().match(/^([0-9][0-9,]*)\s*(?:pcs\.?|pieces?|units?|件|个)?$/i),n=m?Number(m[1].replace(/,/g,'')):NaN;
  out.quantity=Number.isSafeInteger(n)&&n>0?n:null;
 }else out.quantity=null;
 return out;
}
