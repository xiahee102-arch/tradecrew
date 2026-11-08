export function modelRequest(modelName,messages,maxTokens=2500){
 return {model:modelName,messages,temperature:0.2,max_completion_tokens:maxTokens,response_format:{type:'json_object'},thinking:{type:'disabled'}};
}
export function decodeCompletion(data){
 const choice=data.choices?.[0];
 if(choice?.finish_reason==='length'){const e=Error('模型输出达到长度上限，已暂停本次任务，请重试。');e.retryable=true;throw e;}
 const raw=choice?.message?.content;
 if(typeof raw!=='string'||!raw.trim()){const e=Error('模型未返回最终内容，任务没有完成，请重试。');e.retryable=true;throw e;}
 try{const parsed=JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('not an object');return parsed;}
 catch{const e=Error('模型输出格式不符合 JSON，已保留失败记录，可重试。');e.retryable=true;throw e;}
}
export async function requestMimo(env,{modelName,messages,maxTokens=2500,timeoutMs=45000}){
 if(!env.MIMO_API_KEY){const e=Error('MiMo 密钥尚未配置。请在本机启动终端输入密钥，或配置服务端 MIMO_API_KEY。');e.status=503;throw e;}
 let response;
 try{response=await fetch('https://api.xiaomimimo.com/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','api-key':env.MIMO_API_KEY},body:JSON.stringify(modelRequest(modelName,messages,maxTokens)),signal:AbortSignal.timeout(timeoutMs)});}
 catch{const e=Error('MiMo 网络连接超时或中断，已安排重试；请检查运行后端的电脑能否访问小米 API。');e.retryable=true;throw e;}
 let data;try{data=await response.json();}catch{const e=Error('MiMo 返回了无法读取的响应，请检查网络并重试。');e.retryable=true;throw e;}
 if(!response.ok){
  const detail=String(data.error?.message||data.message||'').replaceAll(env.MIMO_API_KEY,'[已隐藏]').slice(0,220);
  const hint=response.status===401?'密钥无效或已失效，请重新配置':response.status===429?'额度不足或请求过于频繁':response.status===400?'请检查模型名或请求参数':response.status===403?'账号或网络访问被拒绝':'供应商暂时不可用';
  const e=Error(`MiMo 请求失败（${response.status}）：${hint}${detail?'；'+detail:''}`);e.status=response.status===401?503:response.status;e.retryable=response.status===429||response.status>=500;const after=response.headers.get('retry-after');if(after){const delay=Number(after);e.retryAfterMs=Number.isFinite(delay)?Math.max(1000,delay*1000):Math.max(1000,Date.parse(after)-Date.now());}throw e;
 }
 return {data,output:decodeCompletion(data)};
}
