#!/usr/bin/env node
// MiMo API 冒烟验证：确认密钥、模型名与请求字段可用。
// 用法：MIMO_API_KEY=xxx node scripts/check-mimo.mjs
// 也可先写入 .dev.vars（本地开发密钥文件）再运行，脚本会自动读取。
import { readFileSync } from 'node:fs';
const BASE = process.env.MIMO_API_BASE || 'https://api.xiaomimimo.com/v1';

function readDotDevVars() {
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

const vars = { ...readDotDevVars(), ...process.env };
const key = vars.MIMO_API_KEY;
const flash = vars.MIMO_FLASH_MODEL || 'mimo-v2.6-flash';
const pro = vars.MIMO_PRO_MODEL || 'mimo-v2.6-pro';

if (!key) {
  console.error('未找到 MIMO_API_KEY。请设置环境变量，或写入 .dev.vars 文件后重试。');
  process.exit(1);
}

const headers = { 'Content-Type': 'application/json', 'api-key': key };
const results = [];
const ok = (name, pass, note) => { results.push({ name, pass, note }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${note ? '  —  ' + note : ''}`); };

async function listModels() {
  try {
    const res = await fetch(BASE + '/models', { headers, signal: AbortSignal.timeout(20000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return ok('列出模型 /models', false, `HTTP ${res.status}：${data.error?.message || '无法列出，改为直接实测'}`);
    const ids = (data.data || data.models || []).map(m => m.id || m);
    ok('列出模型 /models', true, ids.length ? `账户可见模型：${ids.slice(0, 20).join(', ')}` : '返回为空，改为直接实测');
    for (const name of [flash, pro]) {
      if (ids.length && !ids.includes(name)) ok(`模型名在列表中：${name}`, false, '不在 /models 列表里，实测若仍失败请改用账户实际模型名');
    }
    return ids;
  } catch (e) {
    return ok('列出模型 /models', false, e.message);
  }
}

async function chat(model) {
  const payload = {
    model,
    messages: [{ role: 'user', content: '只回复两个字：正常' }],
    temperature: 0.2,
    max_completion_tokens: 16,
  };
  const call = body => fetch(BASE + '/chat/completions', {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
  });
  let res, data, param = 'max_completion_tokens';
  try {
    res = await call(payload);
    data = await res.json().catch(() => ({}));
    if (!res.ok && res.status === 400) {
      param = 'max_tokens';
      const retry = { ...payload }; delete retry.max_completion_tokens; retry.max_tokens = 16;
      res = await call(retry);
      data = await res.json().catch(() => ({}));
    }
  } catch (e) { return ok(`真实调用 ${model}`, false, e.message); }
  if (!res.ok) return ok(`真实调用 ${model}`, false, `HTTP ${res.status}：${data.error?.message || JSON.stringify(data).slice(0, 120)}`);
  const text = data.choices?.[0]?.message?.content ?? '';
  const usage = data.usage || {};
  ok(`真实调用 ${model}`, true,
    `回复「${String(text).trim().slice(0, 20)}」；tokens 入 ${usage.prompt_tokens ?? '?'} 出 ${usage.completion_tokens ?? '?'}；字段 ${param}`);
}

await listModels();
await chat(flash);
if (pro && pro !== flash) await chat(pro);

const failed = results.filter(r => !r.pass);
console.log('\n' + (failed.length ? `${failed.length} 项未通过，请对照说明调整后重试。` : '全部通过：API 密钥与模型可正常调用。'));
process.exit(failed.some(r => r.name.startsWith('真实调用')) ? 1 : 0);
