import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {initializeLocalDatabase} from '../scripts/local-config.mjs';
test('本地首次注册获得明确标注的开发权限，迁移与数据可持久化重启',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tradecrew-local-test-'));const options=()=>{const opts=convertV4MiniflareOptions({modules:true,scriptPath:'dist/server/index.js',compatibilityDate:'2026-01-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'tradecrew-local-db'},r2Buckets:{BUCKET:'tradecrew-local-files'},d1Persist:path.join(dir,'d1'),r2Persist:path.join(dir,'r2'),bindings:{LOCAL_DEV_MODE:'true'}});opts.resourcePersistencePath=dir;return opts;};
 let mf=new Miniflare(options());try{
  await initializeLocalDatabase(mf,process.cwd());const response=await mf.dispatchFetch('http://localhost:8899/api/register',{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':'local_owner',Origin:'http://localhost:8899'},body:JSON.stringify({factory:'本机持久化测试',category:'楼梯五金'})});assert.equal(response.status,200);
  let r=await mf.dispatchFetch('http://localhost:8899/api/state',{headers:{'oai-authenticated-user-id':'local_owner'}});let s=await r.json();assert.equal(s.entitled,true);assert.equal(s.local_mode,true);assert.equal(s.subscription.status,'development');assert.equal(s.payments.length,0);
  await mf.dispose();mf=new Miniflare(options());await initializeLocalDatabase(mf,process.cwd());r=await mf.dispatchFetch('http://localhost:8899/api/state',{headers:{'oai-authenticated-user-id':'local_owner'}});s=await r.json();assert.equal(s.registered,true,JSON.stringify(s));assert.equal(s.factory.factory,'本机持久化测试');assert.equal(s.subscription.status,'development');
 }finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
