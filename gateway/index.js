// Deploy separately on an externally reachable hostname. This does not change the main Site's audience.
const allowed=new Set(['/webhooks/meta','/webhooks/email','/webhooks/payment','/api/scheduler']);
export default {async fetch(request,env){
 const incoming=new URL(request.url);if(!allowed.has(incoming.pathname)||!['GET','POST'].includes(request.method))return new Response('Not found',{status:404});
 if(!env.SITE_ORIGIN||!env.SITE_BYPASS_TOKEN)return new Response('Gateway not configured',{status:503});
 const destination=new URL(env.SITE_ORIGIN);if(destination.protocol!=='https:')return new Response('HTTPS required',{status:503});
 destination.pathname=incoming.pathname;destination.search=incoming.search;
 const headers=new Headers();for(const name of ['content-type','x-hub-signature-256','x-trade-timestamp','x-trade-signature','svix-id','svix-timestamp','svix-signature']){const value=request.headers.get(name);if(value)headers.set(name,value);}
 headers.set('OAI-Sites-Authorization','Bearer '+env.SITE_BYPASS_TOKEN);
 try{const response=await fetch(destination.toString(),{method:request.method,headers,body:request.method==='POST'?request.body:undefined,redirect:'manual'});return new Response(response.body,{status:response.status,headers:{'Content-Type':response.headers.get('Content-Type')||'text/plain','Cache-Control':'no-store'}});}catch{return new Response('Upstream unavailable',{status:502});}
 },async scheduled(event,env,ctx){
 if(!env.SCHEDULER_SECRET)return;const body='{}',ts=String(Date.now());const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.SCHEDULER_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);const sig=[...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(ts+'.'+body)))].map(x=>x.toString(16).padStart(2,'0')).join('');
 ctx.waitUntil(this.fetch(new Request('https://gateway.invalid/api/scheduler',{method:'POST',headers:{'Content-Type':'application/json','X-Trade-Timestamp':ts,'X-Trade-Signature':sig},body}),env));
 }};
