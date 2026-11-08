import {build} from 'esbuild';
import {readdir,readFile,mkdir,writeFile,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const assets={};
async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())await walk(p);else assets['/'+path.relative('dist/client',p).split(path.sep).join('/')]={b:(await readFile(p)).toString('base64'),type:(p.endsWith('.js')||p.endsWith('.mjs'))?'text/javascript':p.endsWith('.css')?'text/css':p.endsWith('.html')?'text/html; charset=utf-8':p.endsWith('.svg')?'image/svg+xml':'application/octet-stream'};}}
await walk('dist/client');
if(process.env.TRADECREW_SOURCE_ARCHIVE!=='false'){
 try{assets['/downloads/source.zip']={b:execFileSync('git',['archive','--format=zip','HEAD'],{maxBuffer:20*1024*1024}).toString('base64'),type:'application/zip'};}catch{console.warn('Source archive not included: Git commit unavailable.');}
}
for(const [url,file] of [['setup.md','docs/接入与部署.md'],['competition.md','docs/比赛交付与验收.md'],['verification.md','docs/设计与验证记录.md']])assets['/downloads/'+url]={b:(await readFile(file)).toString('base64'),type:'text/markdown; charset=utf-8'};
await mkdir('work',{recursive:true});await writeFile('work/assets.js','export default '+JSON.stringify(assets));
await mkdir('dist/server',{recursive:true});await build({entryPoints:['server/index.js'],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:'dist/server/index.js',minify:true});
await mkdir('dist/.openai',{recursive:true});await copyFile('.openai/hosting.json','dist/.openai/hosting.json');
await mkdir('dist/drizzle',{recursive:true});for(const f of await readdir('drizzle'))await copyFile('drizzle/'+f,'dist/drizzle/'+f);
console.log('Worker, assets and D1 migrations built.');
