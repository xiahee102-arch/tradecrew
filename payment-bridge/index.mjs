// 建贸通 · 个人收款码支付桥（比赛演示模式）
// 实现主站 docs/接入与部署.md 中的商户网关契约：
//   POST /                    主站下单（HMAC 验签 + 5 分钟时间窗）→ 返回 checkout_url
//   GET  /checkout/:id        收银页：个人收款码 + 转账备注 + 「我已转账」登记
//   POST /checkout/:id/claim  付款人登记已转账（只登记，不激活任何权益）
//   GET  /admin               店主核对到账 → 人工确认（ADMIN_SECRET 保护）
//   POST /admin/confirm/:id   确认到账后向主站 notify_url 发送重新签名的统一事件
//   GET  /healthz             健康检查
// 说明：个人收款码仅用于比赛演示。激活永远发生在主站验签回调之后，
//      本服务没有「模拟成功即开通」的后门。正式运营必须换微信支付商户/支付宝商家。
const PLANS = {
  trial: { name: '试用版', fen: 9900, days: 14 },
  monthly: { name: '月付版', fen: 39900, days: 30 },
  annual: { name: '年付版', fen: 399000, days: 365 },
};
const METHODS = { wechat: { name: '微信支付', qr: '/wechat-qr.png', hint: '微信扫一扫' }, alipay: { name: '支付宝', qr: '/alipay-qr.png', hint: '支付宝扫一扫' } };
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
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yuan = fen => '¥' + (fen / 100).toFixed(2);
const fmtTime = iso => iso ? new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
function remarkOf(id) { return 'TC-' + id.replace(/-/g, '').slice(-6).toUpperCase(); }
function baseUrl(env) { return String(env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''); }

function layout(title, body, { banner = true } = {}) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · 建贸通</title><style>
:root{--ink:#1c2b2a;--muted:#5c6f6d;--line:#e2e8e7;--bg:#f4f7f6;--card:#fff;--accent:#0f766e;--warn-bg:#fff7ed;--warn-line:#fdba74;--ok:#15803d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif}
.wrap{max-width:560px;margin:0 auto;padding:20px 16px 48px}
.brand{display:flex;align-items:center;gap:10px;padding:6px 2px 18px;color:var(--muted);font-size:13px}
.brand b{color:var(--ink);font-size:15px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px 20px;margin-bottom:14px}
.amount{font-size:34px;font-weight:700;letter-spacing:.5px;margin:2px 0}
.amount small{font-size:13px;font-weight:400;color:var(--muted);margin-left:6px}
.row{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-top:1px dashed var(--line);font-size:14px}
.row:first-of-type{border-top:0}.row span{color:var(--muted)}.row b{font-weight:600;text-align:right;word-break:break-all}
.qr-box{text-align:center;padding:18px 10px 8px}
.qr-box img{width:232px;height:232px;object-fit:contain;border:1px solid var(--line);border-radius:12px;background:#fff}
.qr-fallback{width:232px;height:232px;margin:0 auto;border:1px dashed var(--warn-line);border-radius:12px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:var(--warn-bg);color:#9a3412;font-size:13px;padding:14px;text-align:center}
.remark{margin:12px auto 2px;max-width:320px;background:var(--bg);border-radius:10px;padding:10px 14px;font-size:14px}
.remark b{font-family:ui-monospace,Menlo,monospace;letter-spacing:1px}
.steps{margin:6px 0 0;padding-left:20px;font-size:13.5px;color:var(--muted)}.steps li{margin:4px 0}
.banner{background:var(--warn-bg);border:1px solid var(--warn-line);color:#9a3412;border-radius:12px;padding:12px 14px;font-size:13px;margin-bottom:14px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:13px 18px;border:0;border-radius:12px;background:var(--accent);color:#fff;font-size:16px;font-weight:600;cursor:pointer;text-decoration:none}
.btn:hover{filter:brightness(1.06)}.btn[disabled]{background:#94a3b8;cursor:not-allowed;filter:none}
.btn.alt{background:#fff;color:var(--accent);border:1px solid var(--accent)}
.btn.small{width:auto;padding:8px 14px;font-size:13.5px;border-radius:9px}
.note{font-size:12.5px;color:var(--muted);margin-top:10px;text-align:center}
.ok-text{color:var(--ok);font-weight:600}
h1{font-size:19px;margin:0 0 6px}h2{font-size:15px;margin:16px 0 8px}
table{width:100%;border-collapse:collapse;font-size:12.5px}th,td{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--muted);font-weight:500}
code{background:var(--bg);border-radius:6px;padding:1px 6px;font-size:12px}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;background:#eef2f1}
.pill.ok{background:#dcfce7;color:#166534}.pill.wait{background:#fef3c7;color:#92400e}
.err{color:#b91c1c}
</style></head><body><div class="wrap">
<div class="brand"><b>建贸通</b><span>订阅收银台 · 比赛演示模式</span></div>
${banner ? '<div class="banner"><b>比赛演示模式：</b>使用店主个人收款码收款，转账后由店主人工核对到账并确认开通。正式运营将切换为微信支付商户 / 支付宝商家渠道，接口契约不变。</div>' : ''}
${body}
<p class="note">收款与开通全程留有记录；AI 不接触支付工具。有疑问请联系店主。</p>
</div></body></html>`;
}

async function getOrder(env, id) {
  if (!/^[A-Za-z0-9-]{6,64}$/.test(id || '')) return null;
  return (await env.ORDERS.get('order:' + id, 'json')) || null;
}
async function saveOrder(env, order) { await env.ORDERS.put('order:' + order.id, JSON.stringify(order)); }

async function notifyMainSite(env, order) {
  const target = order.notify_url || env.NOTIFY_URL;
  if (!target) return { ok: false, detail: { error: '未配置 notify_url' } };
  const event = {
    out_trade_no: order.id,
    amount_fen: order.amount_fen,
    currency: 'CNY',
    method: order.method,
    status: 'paid',
    transaction_id: order.transaction_id,
  };
  const raw = JSON.stringify(event), ts = String(Date.now());
  const sig = await hmac(env.BRIDGE_SECRET, ts + '.' + raw);
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Trade-Timestamp': ts, 'X-Trade-Signature': sig },
      body: raw, signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok && data.ok === true, detail: res.ok ? data : { http: res.status, ...data } };
  } catch (e) { return { ok: false, detail: { error: e.message } }; }
}

function checkoutPage(env, order) {
  const plan = PLANS[order.plan_code] || { name: order.plan_code };
  const method = METHODS[order.method] || { name: order.method, qr: '', hint: '扫码' };
  const remark = remarkOf(order.id);
  const paid = order.status === 'paid';
  const body = `
<div class="card">
  <h1>${esc(plan.name)} · 订阅开通</h1>
  <div class="amount">${yuan(order.amount_fen)}<small>一次性支付 · ${plan.days} 天服务期</small></div>
  <div class="row"><span>订单号</span><b>${esc(order.id)}</b></div>
  <div class="row"><span>支付方式</span><b>${esc(method.name)}（个人收款码）</b></div>
  <div class="row"><span>商品</span><b>${esc(order.description || plan.name)}</b></div>
</div>
<div class="card">
  <h2>${paid ? '已确认到账' : '第一步 · 扫码支付'}</h2>
  ${paid ? '<p class="ok-text">店主已核对到账，订阅开通回调已发送至主站。返回工作台即可看到团队状态。</p>'
      : `<div class="qr-box"><img src="${esc(method.qr)}" alt="${esc(method.name)}收款码"
      onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
      <div class="qr-fallback" style="display:none"><b>收款码图片未放置</b>
      <span>请店主把 <code>${esc(method.qr.replace('/', ''))}</code> 放入<br><code>payment-bridge/assets/</code> 后重新部署</span></div></div>
      <div class="remark">转账时请填写备注 <b>${esc(remark)}</b>，方便快速核对</div>
      <ol class="steps">
        <li>用${esc(method.hint)}上方收款码，支付 <b>${yuan(order.amount_fen)}</b></li>
        <li>转账备注填写 <b>${esc(remark)}</b></li>
        <li>点击下方「我已完成转账」登记</li>
        <li>店主核对到账后，订阅自动开通</li>
      </ol>
      <form method="post" action="/checkout/${esc(order.id)}/claim" style="margin-top:14px">
        <button class="btn${order.claimed_at ? ' alt' : ''}" type="submit"${order.claimed_at ? '' : ''}>${order.claimed_at ? '已登记转账，等待店主核对' : '我已完成转账'}</button>
      </form>
      <p class="note">${order.claimed_at ? '登记于 ' + esc(fmtTime(order.claimed_at)) + '。到账核对完成后开通，无需重复登记。' : '请如实登记；本操作不会直接开通任何权益。'}</p>`}
</div>
<div class="card">
  <h2>说明</h2>
  <ol class="steps">
    <li>开通由主站验签回调完成，金额、币种、订单号都会核对，不接受前端声称的支付结果。</li>
    <li>本页为比赛期演示收银，正式商户渠道上线后同一契约直接切换。</li>
  </ol>
  ${order.return_url ? `<p class="note"><a class="text" href="${esc(order.return_url)}">← 返回工作台</a></p>` : ''}
</div>`;
  return layout('完成支付', body);
}

function adminPage(env, orders, token) {
  const rowsHtml = orders.map(o => {
    const plan = PLANS[o.plan_code] || { name: o.plan_code };
    const method = METHODS[o.method] || { name: o.method };
    const status = o.status === 'paid' ? '<span class="pill ok">已确认开通</span>'
      : o.claimed_at ? '<span class="pill wait">已登记待核对</span>' : '<span class="pill">待支付</span>';
    const action = o.status === 'paid'
      ? `<button class="btn small alt" formaction="/admin/confirm/${esc(o.id)}?token=${encodeURIComponent(token)}">重发通知</button>`
      : `<button class="btn small" formaction="/admin/confirm/${esc(o.id)}?token=${encodeURIComponent(token)}">确认到账并开通</button>`;
    return `<tr>
      <td><b>${esc(remarkOf(o.id))}</b><br><code>${esc(o.id.slice(0, 12))}…</code></td>
      <td>${esc(plan.name)}<br>${esc(method.name)}</td>
      <td><b>${yuan(o.amount_fen)}</b></td>
      <td>${status}${o.notify_error ? `<div class="err">通知失败：${esc(String(o.notify_error).slice(0, 60))}</div>` : ''}
        <div>登记：${esc(fmtTime(o.claimed_at))}</div><div>确认：${esc(fmtTime(o.paid_at))}</div></td>
      <td><form method="post">${action}</form></td>
    </tr>`;
  }).join('');
  const body = `
<div class="card">
  <h1>收款确认台</h1>
  <p>确认前请先在${esc(METHODS.wechat.name)} / ${esc(METHODS.alipay.name)}账单里核对<b>实际到账金额与备注</b>。确认后系统才会向主站发送开通回调。</p>
</div>
<div class="card">
  ${orders.length ? `<table><thead><tr><th>备注 / 订单</th><th>套餐 / 渠道</th><th>金额</th><th>状态</th><th>操作</th></tr></thead><tbody>${rowsHtml}</tbody></table>`
      : '<p class="note">暂无订单。主站发起开通后会出现在这里。</p>'}
</div>
<div class="card">
  <h2>当前配置</h2>
  <div class="row"><span>模式</span><b>个人收款码 · 人工确认</b></div>
  <div class="row"><span>主站回调</span><b>${esc(env.NOTIFY_URL || '（按订单 notify_url）')}</b></div>
  <div class="row"><span>收款码</span><b>${esc(METHODS.wechat.qr.replace('/', ''))} / ${esc(METHODS.alipay.qr.replace('/', ''))}（payment-bridge/assets/）</b></div>
</div>`;
  return layout('收款确认台', body, { banner: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), path = url.pathname, method = request.method;

    if (!env.BRIDGE_SECRET) return json({ error: '支付桥尚未配置 BRIDGE_SECRET' }, 503);

    if (path === '/healthz') return json({ ok: true, mode: 'personal-qr-manual-confirm' });

    // —— 主站下单（商户网关契约） ——
    if (path === '/' && method === 'POST') {
      const raw = await request.text();
      const ts = request.headers.get('x-trade-timestamp');
      const signature = request.headers.get('x-trade-signature');
      if (!ts || Math.abs(Date.now() - Number(ts)) > 300000 || !safeEqual(signature, await hmac(env.BRIDGE_SECRET, ts + '.' + raw)))
        return json({ error: 'Invalid signature' }, 401);
      let b;
      try { b = JSON.parse(raw); } catch { return json({ error: 'Invalid JSON' }, 400); }
      const amount = Number(b.amount_fen);
      if (typeof b.out_trade_no !== 'string' || !/^[A-Za-z0-9-]{6,64}$/.test(b.out_trade_no)) return json({ error: 'out_trade_no 无效' }, 400);
      if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1e9) return json({ error: 'amount_fen 无效' }, 400);
      if (b.currency !== 'CNY') return json({ error: '仅支持 CNY' }, 400);
      if (!PLANS[b.plan_code]) return json({ error: 'plan_code 无效' }, 400);
      if (!METHODS[b.method]) return json({ error: 'method 无效' }, 400);
      const notifyUrl = b.notify_url || env.NOTIFY_URL || '';
      if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(notifyUrl)) return json({ error: 'notify_url 必须是 HTTPS' }, 400);
      const existing = await getOrder(env, b.out_trade_no);
      if (existing) return json({ checkout_url: baseUrl(env) + '/checkout/' + existing.id });
      if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(baseUrl(env))) return json({ error: '支付桥 PUBLIC_BASE_URL 必须是 HTTPS（本地回环除外）' }, 503);
      const order = {
        id: b.out_trade_no,
        amount_fen: amount,
        currency: 'CNY',
        plan_code: b.plan_code,
        method: b.method,
        description: typeof b.description === 'string' ? b.description.slice(0, 120) : '',
        notify_url: notifyUrl,
        return_url: typeof b.return_url === 'string' && /^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(b.return_url) ? b.return_url : '',
        expires_at: b.expires_at || new Date(Date.now() + 1800000).toISOString(),
        transaction_id: 'PERSONAL-' + b.out_trade_no,
        status: 'pending',
        created_at: new Date().toISOString(),
        claimed_at: null, paid_at: null, notify_error: null,
      };
      await saveOrder(env, order);
      return json({ checkout_url: baseUrl(env) + '/checkout/' + order.id });
    }

    // —— 收银页 ——
    if (path.startsWith('/checkout/') && method === 'GET') {
      const order = await getOrder(env, path.slice('/checkout/'.length));
      if (!order) return new Response(layout('订单不存在', '<div class="card"><h1>订单不存在或已过期</h1><p>请回到工作台重新发起开通。</p></div>'), { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      return new Response(checkoutPage(env, order), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    // —— 付款人登记「我已转账」——
    if (path.startsWith('/checkout/') && path.endsWith('/claim') && method === 'POST') {
      const id = path.slice('/checkout/'.length, -'/claim'.length);
      const order = await getOrder(env, id);
      if (!order) return json({ error: '订单不存在' }, 404);
      if (order.status === 'paid') return Response.redirect(new URL('/checkout/' + order.id, request.url), 303);
      if (!order.claimed_at) {
        order.claimed_at = new Date().toISOString();
        await saveOrder(env, order);
      }
      return Response.redirect(new URL('/checkout/' + order.id, request.url), 303);
    }

    // —— 店主确认台 ——
    const token = url.searchParams.get('token') || ((request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i) || [])[1] || '';
    const authed = env.ADMIN_SECRET && safeEqual(token, String(env.ADMIN_SECRET));

    if (path === '/admin' && method === 'GET') {
      if (!authed) return new Response(layout('需要口令', `<div class="card"><h1>收款确认台需要口令</h1>
        <form method="get" action="/admin"><input name="token" type="password" placeholder="ADMIN_SECRET" style="width:100%;padding:11px;border:1px solid var(--line);border-radius:10px;margin:10px 0">
        <button class="btn" type="submit">进入</button></form></div>`, { banner: false }), { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      const list = (await env.ORDERS.list({ prefix: 'order:' })).keys;
      const orders = (await Promise.all(list.map(k => env.ORDERS.get(k.name, 'json'))))
        .filter(Boolean).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
      return new Response(adminPage(env, orders, token), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    if (path.startsWith('/admin/confirm/') && method === 'POST') {
      if (!authed) return json({ error: 'Unauthorized' }, 401);
      const order = await getOrder(env, path.slice('/admin/confirm/'.length));
      if (!order) return json({ error: '订单不存在' }, 404);
      const result = await notifyMainSite(env, order);
      order.notify_error = result.ok ? null : JSON.stringify(result.detail).slice(0, 300);
      if (result.ok && order.status !== 'paid') {
        order.status = 'paid';
        order.paid_at = new Date().toISOString();
      }
      await saveOrder(env, order);
      return Response.redirect(new URL('/admin?token=' + encodeURIComponent(token), request.url), 303);
    }

    if (path === '/' && method === 'GET') {
      return new Response(layout('个人收款码支付桥', `<div class="card">
        <h1>支付桥运行中</h1>
        <div class="row"><span>模式</span><b>个人收款码 · 人工确认（比赛演示）</b></div>
        <div class="row"><span>下单契约</span><b>POST /（HMAC 验签）</b></div>
        <div class="row"><span>确认台</span><b><a href="/admin">/admin</a></b></div>
        <div class="row"><span>健康检查</span><b><a href="/healthz">/healthz</a></b></div>
      </div>`), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    return json({ error: 'Not found' }, 404);
  },
};
