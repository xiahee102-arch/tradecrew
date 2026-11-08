# 个人收款码支付桥（比赛演示模式）

实现主站 `docs/接入与部署.md`「支付接口契约」的商户网关：主站下单验签 → 收银页展示**店主个人收款码** → 付款人登记转账 → **店主人工核对到账** → 向主站发送重新签名的开通回调。

> 没有「模拟成功即开通」的后门：开通只发生在主站验签回调之后，主站会核对金额、币种、方式与订单号。本服务只是把「微信/支付宝官方回调」替换为「店主人工确认」，契约完全一致。

## 资金与数据流

1. 主站 `POST /`（`X-Trade-Timestamp` + `X-Trade-Signature`，HMAC-SHA256）→ 返回 `checkout_url`。
2. 老板打开收银页，用另一台设备扫个人收款码，支付对应金额并填写转账备注 `TC-XXXXXX`。
3. 点「我已完成转账」→ 仅登记时间，**不激活任何权益**。
4. 店主在 `/admin`（口令保护）核对微信/支付宝账单实际到账后点「确认到账并开通」。
5. 桥向订单里的 `notify_url`（部署时应指向**公开网关** `/webhooks/payment`）发送统一事件并带 HMAC 签名；主站验签、核对后幂等开通订阅。

## 部署（Cloudflare Workers，约 5 分钟）

```bash
cd payment-bridge
npx wrangler kv namespace create ORDERS     # 把返回的 id 填进 wrangler.jsonc
npx wrangler secret put BRIDGE_SECRET        # 与主站 PAYMENT_BRIDGE_SECRET 相同的高熵随机串
npx wrangler secret put ADMIN_SECRET         # 确认台口令，另取一个随机串
npx wrangler secret put NOTIFY_URL           # https://<公开网关域名>/webhooks/payment
# wrangler.jsonc 的 vars.PUBLIC_BASE_URL 改为部署后的 https://…workers.dev 地址
npx wrangler deploy
```

把你的**个人收款码截图**（微信、支付宝各一张）放入 `assets/`：

- `assets/wechat-qr.png`
- `assets/alipay-qr.png`

图片缺失时收银页会显示放置指引，不会伪造二维码。收款码本身会在收银页公开可见（拿到订单链接的人可看），订单号为随机 UUID，确认台务必使用强口令。

## 主站配置

在主站运行环境秘密设置（或本地 `.dev.vars`）：

```
PAYMENT_BRIDGE_URL=https://tradecrew-pay-bridge.<你>.workers.dev
PAYMENT_BRIDGE_SECRET=<与 BRIDGE_SECRET 相同>
PAYMENT_NOTIFY_URL=https://<公开网关域名>/webhooks/payment
```

主站私有部署时，回调必须经 `gateway/` 公开网关转发（网关已透传 `/webhooks/payment` 与 `X-Trade-*` 头）；网关的 `SITE_ORIGIN` / `SITE_BYPASS_TOKEN` 按 `docs/接入与部署.md` 配置。

## 本地联调

```bash
cd payment-bridge && npx wrangler dev      # 默认 http://localhost:8788
curl -X POST http://localhost:8788/healthz # {"ok":true,...}
```

下单自测（模拟主站签名）：

```bash
BODY='{"out_trade_no":"test-0001","amount_fen":9900,"currency":"CNY","plan_code":"trial","method":"wechat","description":"外贸助手 试用版","notify_url":"http://localhost:8787/webhooks/payment"}'
TS=$(date +%s000)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "你的BRIDGE_SECRET" -hex | sed 's/^.*= //')
curl -X POST http://localhost:8788/ -H 'Content-Type: application/json' -H "X-Trade-Timestamp: $TS" -H "X-Trade-Signature: $SIG" -d "$BODY"
```

注意：主站 `payments.js` 只接受 **HTTPS** 的 `checkout_url`，本地回环联调会被主站拒绝。完整闭环请部署到 `workers.dev`（或给本地桥套 HTTPS 隧道）后再联调。

## 比赛现场口径（请如实说明）

- 支付通道是**个人收款码 + 人工确认**，属于比赛期演示方案；真实付款、真实到账、人工核对，不是「模拟支付按钮」。
- 商户接口已按微信 Native / 支付宝当面付的契约预留：商户网关上线后，只需把主站 `PAYMENT_BRIDGE_URL` 指向商户网关，主站代码零改动。
- 按 `docs/比赛交付与验收.md`：若支付未开通须明确展示「支付未开通」；本演示模式请明确标注，不冒充官方商户收单。

## 合规提示（重要）

**个人收款码不能用于真实经营性收款。** 按人民银行 259 号文及微信/支付宝平台规则，个人码限个人日常转账；经营收款必须使用微信支付商户号 / 支付宝商家（当面付）等商户产品，否则可能被限制收款、冻结资金，并涉及税务合规风险。本目录仅供比赛演示与流程验证；赛后正式对外收费前，请先完成商户资质并切换商户网关。个人码也没有支付回调，「确认到账」只能人工核对——这正是本桥把它显式留在店主手里的原因。
