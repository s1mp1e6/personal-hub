# 短码信令中继（免费套餐）

这个目录提供“短码联动”的信令服务器：两台设备输入一个6位数字即可完成配对，之后数据仍然通过WebRTC点对点传输。

## 为什么需要它
- GitHub Pages只能静态托管，不能提供WebSocket或转发接口。
- 短码并不传输用户数据，只转发SDP/ICE；甚至可以只用STUN接入局域网，不存储任何业务数据。
- 发展量后可以升级为WebSocket后发送，节省请求数。

## 免费额度与成本边界
- Cloudflare Workers 免费计划：每天10万次请求。Durable Object 每天10万次请求。
- 当前方案用短轮询：每个房间两端约400-600次请求/次配对，即使每天200次配对也远远低于免费上限。
- 注意：免费计划的WebSocket长时间保持会使server时长超标，所以本方案先用HTTP轮询。
- 如果发展到需要长连接的场景，上一条路是WebSocket+StateSync+Hibernation(实验性，还不是稳定功能）。

## 部署
```bash
cd signaling
npm i -D wrangler
npx wrangler login
npx wrangler deploy
```

## 前端使用
- 将上面部署的Workers URL填入site/index.html 里的shortRelayUrl()（也可用?relay=URL觥决）。
- 正常使用不需要修改现有二维码/复制粘贴流程。
- 当前已部署：https://personal-hub-shortcode-relay.zal-pc-remote.workers.dev（已填入 site/index.html 的 shortRelayUrl()）。

## 安全边界
- 只允许offer/answer/ice三种消息，每条限KB。
- SIGNALING_SECRETHMAC保护/IP限流，房间只允许两人。
- 房间TTL约5分钟，内存只保留信令历史，不写业务数据。
- 生产硬化前还应加：共享限流器、Turnstile、WebSocket+Hibernation。

## 本地测试
```bash
cd test-tools
npm run test:relay
npm run verify:shortcode
```
