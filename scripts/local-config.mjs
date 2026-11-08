import {readFile,writeFile,mkdir,chmod} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
export function parseVars(text){const out={};for(const line of text.split(/\r?\n/)){const m=line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);if(!m)continue;let value=m[2].trim();if(value.startsWith('"')){try{value=JSON.parse(value)}catch{throw Error('本地配置文件格式不正确：'+m[1]);}}else if(value.startsWith("'")&&value.endsWith("'"))value=value.slice(1,-1);out[m[1]]=value;}return out;}
export async function readLocalVars(root){try{return parseVars(await readFile(path.join(root,'.dev.vars'),'utf8'));}catch(e){if(e.code==='ENOENT')return {};throw e;}}
export async function saveLocalVars(root,vars){const filename=path.join(root,'.dev.vars');const text='# 本机服务端秘密配置，请勿上传或分享。\n'+Object.entries(vars).map(([k,v])=>k+'='+JSON.stringify(String(v))).join('\n')+'\n';await writeFile(filename,text,{mode:0o600});try{await chmod(filename,0o600)}catch{};}
export function isLocalRequest(host,origin,port){const allowed=new Set(['localhost:'+port,'127.0.0.1:'+port]);if(!allowed.has(String(host).toLowerCase()))return false;if(!origin)return true;try{const u=new URL(origin);return u.protocol==='http:'&&allowed.has(u.host.toLowerCase());}catch{return false;}}
export function secureLocalHeaders(incoming){const clean={};for(const [k,v] of Object.entries(incoming)){if(!k.toLowerCase().startsWith('oai-')&&k.toLowerCase()!=='host'&&v!==undefined)clean[k]=Array.isArray(v)?v.join(', '):v;}clean['oai-authenticated-user-id']='local_owner';clean['oai-authenticated-user-email']='local-owner@localhost';return clean;}
export const defaults={MIMO_FLASH_MODEL:'mimo-v2.6-flash',MIMO_PRO_MODEL:'mimo-v2.6-pro'};
export async function initializeLocalDatabase(mf,root){
 const db=await mf.getD1Database('DB');
 await db.prepare('CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)').run();
 const {readdir}=await import('node:fs/promises');
 for(const name of (await readdir(path.join(root,'drizzle'))).filter(n=>n.endsWith('.sql')).sort()){
  if(await db.prepare('SELECT name FROM local_migrations WHERE name=?').bind(name).first())continue;
  const sql=await readFile(path.join(root,'drizzle',name),'utf8');for(const statement of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(statement).run();
  await db.prepare('INSERT INTO local_migrations VALUES (?,?)').bind(name,new Date().toISOString()).run();
 }
 return db;
}
