import {spawn, spawnSync} from 'node:child_process';
import {mkdir, open, readFile, stat, rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import net from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localDir = path.join(root, '.local');
const port = 8899;
process.chdir(root);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function command(args) {
  const result = spawnSync(npm, args, {cwd: root, stdio: 'inherit', shell: process.platform === 'win32'});
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`npm ${args.join(' ')} 失败，退出码 ${result.status}`);
}
async function ready() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/__tradecrew/health`, {signal: AbortSignal.timeout(2000)});
    const body = await response.json();
    return response.ok && body.service === 'tradecrew' && body.ok === true;
  } catch { return false; }
}
async function portAvailable() {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}
async function start() {
  const logPath = path.join(localDir, 'codespaces.log');
  await mkdir(localDir, {recursive: true});
  if (await ready()) return showUrl();
  const lock = path.join(localDir, 'codespaces-start.lock');
  try { await mkdir(lock); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    for (let attempt = 0; attempt < 90; attempt++) {
      if (await ready()) return showUrl();
      try { await stat(lock); } catch { return start(); }
      await delay(1000);
    }
    throw Error('启动锁等待超时；查看 .local/codespaces.log，确认无启动进程后删除 .local/codespaces-start.lock 再重试。');
  }
  try {
    if (await ready()) return showUrl();
    if (!await portAvailable()) throw Error('8899 端口被其他程序占用，请先关闭该程序。');
    await stat(path.join(root, 'dist/server/index.js'));
    const log = await open(logPath, 'a');
    let child;
    try {
      child = spawn(process.execPath, ['scripts/local.mjs', '--no-build'], {
        cwd: root, detached: true,
        env: {...process.env, PORT: String(port), TRADECREW_CLOUD_PREVIEW: 'true'},
        stdio: ['ignore', log.fd, log.fd]
      });
    } finally { await log.close(); }
    let spawnError;
    child.on('error', error => { spawnError = error; });
    child.unref();
    for (let attempt = 0; attempt < 90; attempt++) {
      if (spawnError) throw spawnError;
      if (await ready()) return showUrl();
      if (child.exitCode !== null || child.signalCode !== null) throw Error('服务提前退出，请查看 .local/codespaces.log。');
      await delay(1000);
    }
    throw Error('服务启动超时，请查看 .local/codespaces.log。');
  } finally {
    // This directory is created only by this launcher, directly below .local.
    await rm(lock, {recursive: true, force: true});
  }
}
function showUrl() {
  const name = process.env.CODESPACE_NAME;
  const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev';
  console.log(`建贸通 已启动：http://localhost:${port}/`);
  if (name) console.log(`软件入口：https://${name}-${port}.${domain}/`);
  console.log('保留 8899 端口为 Private。模型密钥通过 Codespaces Secrets 配置 MIMO_API_KEY。');
}
try {
  if (process.argv[2] === 'setup') {
    const [major] = process.versions.node.split('.').map(Number);
    if (major < 24) throw Error('云端环境需要 Node.js 24 或更新版本。');
    command(['ci', '--no-audit', '--no-fund']);
    command(['run', 'build']);
    console.log('依赖和前后端构建已完成，容器启动后会自动运行 建贸通。');
  } else if (process.argv[2] === 'start') {
    await start();
  } else {
    throw Error('用法：node scripts/codespaces.mjs setup | start');
  }
} catch (error) {
  console.error(`建贸通 自动启动失败：${error.message}`);
  process.exitCode = 1;
}
