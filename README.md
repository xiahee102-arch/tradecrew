# 建贸通 · AI 出海团队

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/xiahee102-arch/tradecrew/tree/main)

## 一键在云端运行

点击上方按钮并选择 **Create codespace**。项目会使用 Node.js 24，自动安装依赖、构建前后端、初始化本地数据库并启动 8899 端口，服务启动后自动打开软件页面。首次创建需要等待环境准备完成。

未配置模型密钥时也能进入界面；真实 AI 功能需要在 [Codespaces Secrets](https://github.com/settings/codespaces) 添加 `MIMO_API_KEY`，并授权此仓库。已有 Codespace 添加 Secret 后需停止再启动，使新 Secret 生效。不要把密钥写进源码。

软件页面对应 **PORTS → 8899 → Open in Browser**。请保留端口为 **Private**，本模式使用单用户开发身份，不作为公开多人服务。每个 Codespace 拥有独立数据；记录和文件保存在 `.local/state/`，删除 Codespace 会丢失未导出的数据。

已有旧环境不会自动获得新代码。先保存或提交自己的修改，再运行 `git pull --ff-only`，然后执行命令面板 **Codespaces: Rebuild Container**。重建后会重新安装、构建和启动；上方入口新建环境时直接使用 `main` 最新内容。

启动失败可查看 `.local/codespaces.log`。手动重新启动使用 `npm run codespaces:start`；源码修改后的日常开发可在终端停止旧服务后执行 `npm run local`，它会重新构建并启动。

在自己的电脑运行：安装 Node.js 24 后执行 `npm ci` 和 `npm run local`，或使用 `start-local.bat` / `start-local.command`，首次按提示输入模型密钥。

服务中国建材工厂的全栈平台：真实工厂工作区、可追溯产品事实、MiMo 七岗协作、市场战略、询盘收件箱、程序报价与双钥匙审批、订单记录、内容、渠道连接和订阅支付接口。

- React 19 + Vite，响应式中文工作台，空数据起步。
- Cloudflare Worker + D1 + R2，依赖 Sites 认证边界。
- MiMo flash / pro 服务端调用，持久队列和审计。
- WhatsApp Cloud API / Facebook Messenger 官方连接器；需自己的账号、令牌、公共回调网关。
- 微信/支付宝商户网关契约；未配置不产生虚假付款。比赛期可部署 `payment-bridge/`（个人收款码 + 人工确认）演示闭环，正式运营换商户网关。
- `scripts/check-mimo.mjs`：拿到 MIMO_API_KEY 后一条命令核验密钥、模型名与请求字段。

```bash
npm ci
npm run build
npm test
```

详细接入与限制：[docs/接入与部署.md](docs/接入与部署.md)
比赛映射与验收：[docs/比赛交付与验收.md](docs/比赛交付与验收.md)

生产必须配置模型密钥、商户网关、Meta 应用和无人值守调度，才能完成真实外部业务。邮件通过 Resend 官方 API 接入，需要企业域名和接收 Webhook。未实装能力详见接入文档，不能称为全部比赛验收已通过。
