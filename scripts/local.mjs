import http from 'node:http';
import {readFile,mkdir,access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {fetch as outboundFetch,EnvHttpProxyAgent} from 'undici';
import {defaults,readLocalVars,saveLocalVars,isLocalRequest,secureLocalHeaders,initializeLocalDatabase,codespacesOrigin} from './local-config.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');process.chdir(root);
async function hiddenInput(prompt){
 if(!process.stdin.isTTY)throw Error('首次启动需要在交互终端输入密钥，或先在 .dev.vars 配置 MIMO_API_KEY。');
 process.stdout.write(prompt);const input=process.stdin;input.setRawMode(true);input.resume();input.setEncoding('utf8');
 return new Promise((resolve,reject)=>{let value='';const finish=()=>{input.removeListener('data',onData);input.setRawMode(false);input.pause();process.stdout.write('\n');};function onData(chunk){for(const ch of chunk){if(ch==='\r'||ch==='\n'){finish();resolve(value.trim());return;}if(ch==='\u0003'){finish();reject(Error('已取消启动'));return;}if(ch==='\u007f'||ch==='\b')value=value.slice(0,-1);else if(ch>=' ')value+=ch;}}input.on('data',onData);});
}
let vars={...defaults,...await readLocalVars(root)};
for(const name of Object.keys(vars))if(process.env[name])vars[name]=process.env[name];
if(process.env.MIMO_API_KEY)vars.MIMO_API_KEY=process.env.MIMO_API_KEY;
const cloudPreview=process.env.CODESPACES==='true'&&process.env.TRADECREW_CLOUD_PREVIEW==='true';
if(!vars.MIMO_API_KEY&&!cloudPreview){vars.MIMO_API_KEY=await hiddenInput('请粘贴 MiMo API Key（隐藏输入，按回车保存到本机）：');if(!vars.MIMO_API_KEY.startsWith('sk-'))throw Error('密钥格式不符，请使用小米按量计费 API Key。');}
if(!vars.MIMO_API_KEY)console.warn('尚未配置 MIMO_API_KEY：界面可以打开，真实 AI 功能需要配置 Codespaces Secret 后重启服务。');
if(!vars.TOKEN_ENCRYPTION_KEY)vars.TOKEN_ENCRYPTION_KEY=randomBytes(32).toString('hex');
await saveLocalVars(root,vars);
if(process.argv.includes('--configure-only')){console.log('本机秘密配置已保存。');process.exit(0);}
if(!process.argv.includes('--no-build')){console.log('正在构建本地版本…');const result=spawnSync(process.platform==='win32'?'npm.cmd':'npm',['run','build'],{cwd:root,stdio:'inherit',shell:process.platform==='win32'});if(result.status!==0)process.exit(result.status||1);}
const stateDir=path.join(root,'.local','state');await mkdir(stateDir,{recursive:true});
const bindings={...vars,LOCAL_DEV_MODE:'true'};
const dispatcher=new EnvHttpProxyAgent();
const mfOptions=convertV4MiniflareOptions({modules:true,scriptPath:path.join(root,'dist/server/index.js'),compatibilityDate:'2026-01-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'tradecrew-local-db'},r2Buckets:{BUCKET:'tradecrew-local-files'},d1Persist:path.join(stateDir,'d1'),r2Persist:path.join(stateDir,'r2'),bindings,cf:false,outboundService:async request=>{const result=await outboundFetch(request.url,{method:request.method,headers:Object.fromEntries(request.headers),...(['GET','HEAD'].includes(request.method)?{}:{body:await request.arrayBuffer()}),dispatcher});const headers=new Headers(result.headers);headers.delete('content-encoding');headers.delete('content-length');return new Response([204,205,304].includes(result.status)?null:await result.arrayBuffer(),{status:result.status,headers});}});
mfOptions.resourcePersistencePath=stateDir;
const mf=new Miniflare(mfOptions);
await initializeLocalDatabase(mf,root);
const port=Number(process.env.PORT||8899);if(!Number.isInteger(port)||port<1024||port>65535)throw Error('PORT 应为1024到65535之间的端口');
const cloudOrigin=codespacesOrigin(port);
const server=http.createServer(async(req,res)=>{
 try{
  if(!isLocalRequest(req.headers.host,req.headers.origin,port,cloudOrigin)){res.writeHead(403,{'Content-Type':'text/plain; charset=utf-8'});res.end('仅允许本机或当前 Codespace 的同源请求');return;}
  if(req.url==='/__tradecrew/health'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({ok:true,service:'tradecrew'}));return;}
  if(req.url.startsWith('/signin-with-chatgpt')||req.url.startsWith('/signout-with-chatgpt')){res.writeHead(303,{Location:'/'});res.end();return;}
  let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>22*1024*1024){res.writeHead(413);res.end('文件过大');return;}chunks.push(chunk);}
  const requestOrigin=cloudOrigin&&(req.headers.origin===cloudOrigin||req.headers.host===new URL(cloudOrigin).host)?cloudOrigin:'http://'+req.headers.host;
  const response=await mf.dispatchFetch(requestOrigin+req.url,{method:req.method,headers:secureLocalHeaders(req.headers),...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})});
  res.writeHead(response.status,Object.fromEntries(response.headers));if(response.body)for await(const chunk of response.body)res.write(chunk);res.end();
 }catch(e){if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json; charset=utf-8'});const message=vars.MIMO_API_KEY?String(e.message).replaceAll(vars.MIMO_API_KEY,'[已隐藏]'):String(e.message);res.end(JSON.stringify({error:'本地服务错误：'+message}));}
});
server.on('error',async e=>{console.error(e.code==='EADDRINUSE'?`端口 ${port} 已占用，请先关闭旧版服务，或设置 PORT 换一个端口。`:'本地服务启动失败：'+e.message);await mf.dispose();process.exit(1);});
server.listen(port,'127.0.0.1',()=>{console.log(`\n建贸通已启动：http://localhost:${port}/\n本机单用户开发模式；数据库保存在 .local/state。密钥仅保存在本机 .dev.vars。\n新建工厂提供14天开发权限，账单不会伪造为已支付。请勿将此本地服务暴露到公网。\n按 Ctrl+C 关闭。`);});
async function close(){server.close();await mf.dispose();await dispatcher.close();process.exit(0)}process.once('SIGINT',close);process.once('SIGTERM',close);
