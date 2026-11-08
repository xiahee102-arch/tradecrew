// 受信任开发代理（隧道演示入口）：团队口令登录 + 每人独立工作区。
// 仅用于本地/隧道演示：生产身份必须由 Sites 身份网关提供，禁止正式公网部署。
// 用法：先 `wrangler dev`（上游 http://127.0.0.1:8787），再 `node scripts/dev-proxy.mjs`（http://127.0.0.1:8899）。
import { createServer, request as httpRequest } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = 8787;
const LISTEN_PORT = Number(process.env.DEV_PROXY_PORT || 8899);

function parseDotDevVars() {
  try {
    const text = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
    const out = {};
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in out)) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return out;
  } catch { return {}; }
}
const vars = parseDotDevVars();
const PASSWORD = process.env.DEMO_LOGIN_PASSWORD || vars.DEMO_LOGIN_PASSWORD || 'tradecrew-demo';
const NAME_RE = /^[a-zA-Z0-9_\-一-龥]{2,20}$/;

const sign = user => createHmac('sha256', PASSWORD).update('tc:' + user).digest('hex');
const makeCookie = user => `tc_auth=${encodeURIComponent(user)}.${sign(user)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
const CLEAR_COOKIE = 'tc_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';

function sessionUser(req) {
  const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('tc_auth='));
  if (!raw) return null;
  const value = decodeURIComponent(raw.slice('tc_auth='.length));
  const i = value.lastIndexOf('.');
  if (i < 1) return null;
  const user = value.slice(0, i), sig = value.slice(i + 1);
  const expect = sign(user);
  if (sig.length !== expect.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  return NAME_RE.test(user) ? user : null;
}

function loginPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · 建贸通</title><style>
:root{--teal:#126b5d;--ink:#1c2b25;--muted:#7d8982;--line:#dfe6e2}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f7f6;font:15px/1.7 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:var(--ink)}
.card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:38px 34px;width:min(400px,92vw);box-shadow:0 12px 40px #23392c0d}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:22px}.brand span{width:34px;height:34px;border-radius:9px;background:var(--teal);color:#fff;display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:700}
.brand b{font-size:19px;letter-spacing:.5px}h1{font-size:18px;margin:0 0 6px}p.sub{color:var(--muted);font-size:12.5px;margin:0 0 22px;line-height:1.8}
label{display:block;font-size:12px;font-weight:550;color:#51675a;margin:0 0 7px}input{width:100%;padding:12px 13px;border:1px solid var(--line);border-radius:8px;font-size:14px;outline:none;background:#fcfdfc}
input:focus{border-color:var(--teal);box-shadow:0 0 0 3px #126b5d14}.field{margin-bottom:16px}
button{width:100%;padding:13px;border:0;border-radius:9px;background:var(--teal);color:#fff;font-size:15px;font-weight:600;cursor:pointer;margin-top:6px}
button:hover{filter:brightness(1.07)}.err{background:#fcece9;color:#ad5043;border-radius:8px;padding:10px 12px;font-size:12.5px;margin-bottom:14px;display:none}
.note{margin-top:18px;font-size:11px;color:#94a095;line-height:1.9;text-align:center}
</style></head><body><div class="card">
<div class="brand"><span>盾</span><b>建贸通</b></div>
<h1>登录到你的工作区</h1>
<p class="sub">输入团队口令和你的名字。每个人使用独立的工作区，互不干扰。</p>
<div class="err" id="err"></div>
<form method="post" action="/login">
<div class="field"><label for="u">你的名字</label><input id="u" name="username" placeholder="例如：小王" minlength="2" maxlength="20" required autofocus></div>
<div class="field"><label for="p">团队口令</label><input id="p" name="password" type="password" placeholder="向团队负责人获取" required></div>
<button type="submit">进入工作区</button>
</form>
<p class="note">口令由团队负责人统一分配；忘记口令请联系负责人。</p>
</div>
<script>var q=new URLSearchParams(location.search).get('e');if(q){var el=document.getElementById('err');el.textContent=q==='bad'?'口令不正确，请重试。':'名字格式不正确（2-20 个字母、数字或中文）。';el.style.display='block';}</script>
</body></html>`;
}

function proxy(req, res, user) {
  const safe = encodeURIComponent(user); // HTTP 头只允许 ASCII，中文名需编码
  const tenant = user === 'demo' ? 'dev-boss-0001' : 'user-' + safe;
  const headers = {
    ...req.headers,
    host: req.headers.host || `127.0.0.1:${LISTEN_PORT}`,
    'oai-authenticated-user-id': tenant,
    'oai-authenticated-user-email': safe + '@demo.local',
  };
  const proxied = httpRequest(
    { hostname: UPSTREAM_HOST, port: UPSTREAM_PORT, path: req.url, method: req.method, headers },
    up => { res.writeHead(up.statusCode, up.headers); up.pipe(res); },
  );
  proxied.on('error', e => {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('上游应用未就绪：' + e.message + '（请先运行 wrangler dev）');
  });
  req.pipe(proxied);
}

createServer((req, res) => {
 try {
  const url = new URL(req.url, 'http://localhost');

  // 退出登录（应用内“退出登录”按钮指向 /signout-with-chatgpt）
  if (url.pathname === '/logout' || url.pathname.startsWith('/signout-with-chatgpt')) {
    res.writeHead(302, { 'Set-Cookie': CLEAR_COOKIE, Location: '/' });
    return res.end();
  }

  // 登录提交
  if (url.pathname === '/login' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    return req.on('end', () => {
      try {
        const form = new URLSearchParams(body);
        const user = (form.get('username') || '').trim();
        const pass = form.get('password') || '';
        const passOk = Buffer.from(pass).length === Buffer.from(PASSWORD).length &&
          timingSafeEqual(Buffer.from(pass), Buffer.from(PASSWORD));
        if (!passOk) { res.writeHead(302, { Location: '/?e=bad' }); return res.end(); }
        if (!NAME_RE.test(user)) { res.writeHead(302, { Location: '/?e=name' }); return res.end(); }
        res.writeHead(302, { 'Set-Cookie': makeCookie(user), Location: '/' });
        res.end();
      } catch (e) { res.writeHead(500); res.end('login error'); }
    });
  }

  const user = sessionUser(req);
  if (!user) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(loginPage());
  }

  if (url.pathname === '/login') { res.writeHead(302, { Location: '/' }); return res.end(); }
  proxy(req, res, user);
 } catch (e) {
  res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('proxy error');
 }
}).listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`dev proxy (login gate): http://127.0.0.1:${LISTEN_PORT} -> http://${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
  console.log(`登录口令来自 .dev.vars DEMO_LOGIN_PASSWORD；名字 demo 映射到演示工作区。`);
});
