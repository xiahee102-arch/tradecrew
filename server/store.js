export const uid=()=>crypto.randomUUID();
export const now=()=>new Date().toISOString();
export async function query(env,sql,...args){return (await env.DB.prepare(sql).bind(...args).all()).results;}
export async function one(env,sql,...args){return env.DB.prepare(sql).bind(...args).first();}
export async function run(env,sql,...args){return env.DB.prepare(sql).bind(...args).run();}
export async function records(env,tenant,kind){const rows=await query(env,'SELECT * FROM records WHERE tenant=? AND kind=? ORDER BY created_at DESC',tenant,kind);return rows.map(r=>({...r,data:JSON.parse(r.data)}));}
export async function record(env,tenant,id){const r=await one(env,'SELECT * FROM records WHERE tenant=? AND id=?',tenant,id);return r?{...r,data:JSON.parse(r.data)}:null;}
export async function put(env,tenant,kind,data,id=uid()){
 await run(env,'INSERT INTO records (id,tenant,kind,data,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at WHERE records.tenant=excluded.tenant',id,tenant,kind,JSON.stringify(data),now(),now());return id;
}
export async function audit(env,tenant,actor,action,entity,detail={}){await run(env,'INSERT INTO audit VALUES (?,?,?,?,?,?,?)',uid(),tenant,actor,action,entity,JSON.stringify(detail),now());}
export function json(data,status=200){return Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
export function fail(message,status=400){const e=Error(message);e.status=status;throw e;}
export async function active(env,tenant){const s=await one(env,'SELECT * FROM subscriptions WHERE tenant=?',tenant);return s&&Date.parse(s.expires_at)>Date.now()&&(s.status==='active'||(env.LOCAL_DEV_MODE==='true'&&s.status==='development'))?s:null;}

export async function quota(env,tenant,kind,id,limit,since){
 const r=await run(env,"INSERT OR IGNORE INTO quota_events (id,tenant,kind,created_at) SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM quota_events WHERE tenant=? AND kind=? AND created_at>=?)<?",id,tenant,kind,now(),tenant,kind,since,limit);
 if(!r.meta.changes){const existing=await one(env,'SELECT id FROM quota_events WHERE id=? AND tenant=?',id,tenant);if(!existing)fail('当前套餐的'+(kind==='inquiry'?'询盘':'内容')+'配额已用完，请续费或联系管理员。',429);}
}
