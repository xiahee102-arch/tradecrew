// 演示部署的口令登录：仅当环境变量 DEMO_LOGIN_PASSWORD 配置时启用。
// 生产（Sites 托管）不配置该变量，行为不变，身份仍由托管边界提供。
const NAME_RE = /^[a-zA-Z0-9_\-一-龥]{2,20}$/;
const enc = new TextEncoder();

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let n = 0; for (let i = 0; i < a.length; i++) n |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return n === 0;
}
export function tenantOf(user) { return user === 'demo' ? 'dev-boss-0001' : 'user-' + encodeURIComponent(user); }

export async function sessionUser(env, request) {
  const raw = (request.headers.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith('tc_auth='));
  if (!raw) return null;
  const value = decodeURIComponent(raw.slice('tc_auth='.length));
  const i = value.lastIndexOf('.');
  if (i < 1) return null;
  const user = value.slice(0, i), sig = value.slice(i + 1);
  if (!NAME_RE.test(user)) return null;
  return safeEqual(sig, await hmac(env.DEMO_LOGIN_PASSWORD, 'tc:' + user)) ? user : null;
}

export async function handleLogin(request, env) {
  const url = new URL(request.url), path = url.pathname;
  if (path === '/logout' || path.startsWith('/signout-with-chatgpt')) {
    return new Response(null, { status: 302, headers: { 'Set-Cookie': 'tc_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0', Location: '/' } });
  }
  if (path !== '/login') return null;
  if (request.method === 'GET') return new Response(loginPage(), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const form = new URLSearchParams(await request.text());
  const user = (form.get('username') || '').trim(), pass = form.get('password') || '';
  const passOk = safeEqual(pass, String(env.DEMO_LOGIN_PASSWORD));
  if (!passOk) return new Response(null, { status: 302, headers: { Location: '/?e=bad' } });
  if (!NAME_RE.test(user)) return new Response(null, { status: 302, headers: { Location: '/?e=name' } });
  const sig = await hmac(env.DEMO_LOGIN_PASSWORD, 'tc:' + user);
  return new Response(null, { status: 302, headers: { 'Set-Cookie': `tc_auth=${encodeURIComponent(user)}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`, Location: '/' } });
}

export function loginPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · 外贸助手</title><style>
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
<div class="brand"><span>盾</span><b>外贸助手</b></div>
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
