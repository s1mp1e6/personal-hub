# 现在就能上线的实操方案（子域名 + 国内替代）

> 说明：以下步骤按腾讯 EdgeOne 官方文档整理；DNS 部分已按 `zal.best` 的实测状态（NS 指向 Cloudflare）改写。本文档未经端到端实操，控制台文案若与当前版本不一致，以实际页面为准。

本文档回答三件事：只搞定域名够不够、其他环节有没有国内替代、`zal.best` 怎么开出 `hub.zal.best`。按顺序照着点即可。整体战略和备案路线见《国内访问部署手册》。

## 零、最快照抄版（约 10 分钟）

> 你不需要去 Spaceship 开子域名。`zal.best` 的 DNS 已经托管到 Cloudflare（本会话实测 NS：`woz.ns.cloudflare.com` / `dayana.ns.cloudflare.com`，且 `zal.best` 在 Cloudflare 账号下状态为 active）；开子域名 = 在 Cloudflare 加一条 CNAME，按下面顺序照抄即可。

1. 打开 https://pages.edgeone.ai，用腾讯云账号登录（没有就先注册并完成实名认证）。
2. 新建项目 → 导入 GitHub 仓库 → 选 `s1mp1e6/personal-hub`。
3. 项目设置：仓库根目录已带 `edgeone.json`，会自动把输出目录覆盖为 `site` 并下发 no-cache 响应头；控制台若没自动识别，再手动把输出目录填 `site`。构建命令留空，加速区域选“全球可用区（不含中国大陆）”，点“开始部署”。
4. 进项目“域名管理”→“添加自定义域名”，输入 `hub.zal.best`，按弹窗记下两样东西：验证 TXT 内容、CNAME 目标地址。
5. 打开 https://dash.cloudflare.com → 点 `zal.best` → 左侧“DNS” → “记录 / Records” → “添加记录 / Add record”：
   - 先加 TXT：类型 `TXT`，名称按 EdgeOne 提示（通常是 `hub` 或 `_cf-custom-hostname`），内容填验证串；
   - 再加 CNAME：类型 `CNAME`，名称 `hub`（不要写 `hub.zal.best` 全名），目标填 EdgeOne 给的地址，代理状态选“仅 DNS / DNS only”。
6. 回 EdgeOne 点验证，等状态变为“CNAME 已生效”；再到“域名管理 → HTTPS 配置”确认或开启 EdgeOne 免费证书。
7. 用手机流量和家里宽带分别打开 `https://hub.zal.best` 验证。

这就是“开子域名”的全部内容：Spaceship 那边不用动。

> 关于你贴的 Spaceship 链接：`https://www.spaceship.com/zh/application/domain-list-application/?userProductId=679e421e-fca7-4bd8-9815-973e3ca8e8ae` 需要登录才能进入，它是 Spaceship 账号内的应用/域名页面。因为 `zal.best` 的 NS 实测已经指向 Cloudflare，DNS 操作（开 `hub.zal.best`）要登录 `https://dash.cloudflare.com` 做，Spaceship 那边不用操作；如果登录后不放心，先跑下方第四步的自查命令确认 NS，再决定去哪里加记录。


## 一、先回答三个问题

1. 只搞定域名就可以了吗？
   不行。上线一共三件事：域名解析（DNS）、静态托管、短码信令中继。缺一不可，但只有域名需要你手动点几下，托管和中继都有现成的替代方案。
2. 其他都有国内替代吗？
   有。对照表如下：

   | 环节 | 现在用的 | 国内替代 | 状态 |
   | --- | --- | --- | --- |
   | 静态托管 | GitHub Pages | EdgeOne Makers（腾讯，免费） | 可用，本文档第一步 |
   | 短码信令中继 | Cloudflare Worker + Durable Object | EdgeOne Pages Functions + 存储，或 CloudBase 云函数 + 数据库 | 可用，后续迁移 |
   | DNS | Spaceship 注册、Cloudflare 托管（NS 实测已指向 Cloudflare） | 继续用 Cloudflare 即可 | 现在不动 |
   | 大陆稳定节点 | 无 | 必须 ICP 备案 | 需要新 `.cn`/`.com` 域名，见战略文档 |

   唯一没有“合法免费替代”的是大陆稳定节点：不备案只能用“全球可用区（不含中国大陆）”，能打开但看运气。
3. 我不会开子域名？
   很简单，就是给 `zal.best` 加一条 CNAME 记录，指向 EdgeOne。详细点击步骤在下面。

## 二、完整链路

浏览器访问 `https://hub.zal.best` → Cloudflare DNS 的 CNAME 指向 EdgeOne → EdgeOne Pages 托管 `site/` 静态页面 → 页面里的短码信令请求同一套 EdgeOne/CloudBase 接口 → 两台设备交换完 SDP/ICE 后走 WebRTC 点对点直连。

用户数据始终只在两台设备本地，中继只转发配对信息。

## 三、第一步：EdgeOne Makers 部署站点（约 10 分钟，先做这个）

1. 打开 `https://pages.edgeone.ai`，用腾讯云账号登录；没有就先注册并完成个人实名认证。
2. 新建项目，选择“导入 GitHub 仓库”，授权后选择 `s1mp1e6/personal-hub`（本地 `git remote -v` 已确认是这个仓库）。
3. 项目设置按以下填：
   - 输出目录/根目录：`site`
   - 构建命令：留空（纯静态文件，不需要构建）
   - 加速区域：全球可用区（不含中国大陆）← 未备案前只能选这个
4. 点“开始部署”。先在 EdgeOne 控制台预览，或从非大陆网络打开系统分配的项目域名，确认首页、主题、本地数据都正常。
   > 注意：加速区域为“全球可用区（不含中国大陆）”时，官方文档说明系统分配的项目域名从大陆网络访问可能返回 401，所以大陆手机实测必须等绑定 `hub.zal.best` 自定义域名后再做。

如果 GitHub 导入卡住，备选方式是“直接上传（Direct Upload）”：Makers 控制台 → 新建项目 → Direct Upload → 填项目名与加速区域 → 上传 `site` 文件夹，或直接上传本仓库已打好的 `dist/personal-hub-site.zip`（压缩包根目录已确认包含 `index.html` 和 `edgeone.json`，后者用于在 Direct Upload 下同样下发 no-cache 响应头）。Direct Upload 不执行构建，上传完即可托管静态文件。

官方参考（以页面实际为准）：
- 导入 Git 仓库：https://pages.edgeone.ai/zh/document/importing-a-git-repository
- 直接上传：https://pages.edgeone.ai/zh/document/direct-upload
- 自定义域名：https://pages.edgeone.ai/zh/document/custom-domain
- HTTPS 证书配置：https://pages.edgeone.ai/zh/document/configuring-an-https-certificate
- 域名管理概览（加速区域与备案要求）：https://pages.edgeone.ai/zh/document/domain-overview

## 四、第二步：在 Cloudflare 添加 `hub` 子域名（约 5 分钟）

你的域名虽然是在 Spaceship 买的，但实测 `zal.best` 的 NS 已经是 Cloudflare（`woz.ns.cloudflare.com` / `dayana.ns.cloudflare.com`），DNS 记录要在 Cloudflare 控制台加，不在 Spaceship 的 DNS 页。先在第五步拿到 EdgeOne 的验证记录和 CNAME 目标，再回来加。
> Cloudflare 控制台中英文自动切换，找不到对应项就按英文名（DNS → Records → Add record）搜。

0. 先自查 DNS 现在归谁管（Windows PowerShell）：
   ```powershell
   Resolve-DnsName zal.best -Type NS
   ```
   只要结果里有 `ns.cloudflare.com`，就去 Cloudflare 控制台加记录（`zal.best` 实测就是这样）；如果显示的是 Spaceship/Namecheap 之类的 NS，才回 Spaceship 加。

1. 打开 `https://dash.cloudflare.com`，用 wrangler 登录时用的邮箱登录。
2. 在“主页”里点 `zal.best` 进入该域名；如果列表里没有，说明登错账号（NS 已指向 Cloudflare，登录后一定能看到）。
3. 左侧点“DNS” → “记录 / Records” → “添加记录 / Add record”。
4. 先加验证记录：EdgeOne 弹窗给 TXT 时，类型选 `TXT`，名称按提示填（通常是 `hub` 或 `_cf-custom-hostname`），内容填验证串，点保存。
5. 再加 CNAME，字段按下面填：
   - 类型（Type）：`CNAME`
   - 名称（Name）：`hub` ← 只填 `hub`，不要填 `hub.zal.best` 全名，也不要动 `@`
   - 目标（Target）：填 EdgeOne 绑定域名时给的目标地址，形如 `xxxxxxxx.edgeone.app`（还没拿到就先做第五步）
   - 代理状态（Proxy status）：选“仅 DNS / DNS only”（灰色云朵），不要开橙色云朵；TTL 自动即可
6. 点“保存 / Save”。
7. 验证命令（Windows）：
   ```powershell
   Resolve-DnsName hub.zal.best -Type CNAME
   nslookup -qt=cname hub.zal.best
   ```
   生效通常几分钟到几小时，最长 48 小时。

注意：只添加 `hub` 这一条 CNAME（和验证 TXT），不要改 `zal.best` 根域其他记录，另一个项目还在用。

如果你希望由我来自动加 DNS：登录 Cloudflare → 右上角头像 → My Profile → API Tokens → Create Token → 选 Edit zone DNS 模板，Zone 限定为 zal.best，把生成的 Token 发我即可；拿到 EdgeOne 的 CNAME 目标后我可以直接加记录并复测。Token 只有 zal.best 的 DNS 编辑权限，不影响你其他项目。

更省事的本机一键版：创建同样权限的 Token 后不用发给任何人，直接在本地 PowerShell 跑：

``powershell
$env:CLOUDFLARE_API_TOKEN = "你的Token"
powershell -NoProfile -ExecutionPolicy Bypass -File tools/cloudflare-add-dns.ps1 -CnameTarget "EdgeOne给的CNAME目标" -TxtName "hub" -TxtValue "EdgeOne给的验证串"
``

脚本会自动创建/核对 TXT 和 hub 的 CNAME，并复测 DNS 是否生效；Token 只在本机使用。

## 五、第三步：把 `hub.zal.best` 绑定到 EdgeOne

1. 回到 EdgeOne Makers，进入项目详情，切到“域名管理”页。
2. 点“添加自定义域名”，输入 `hub.zal.best`。
3. 按弹窗提示做两步：
   - 验证归属权：在 Cloudflare 按第四步的方法加一条验证记录（通常是 TXT），回到 EdgeOne 点验证。
   - 添加 CNAME：EdgeOne 会显示 CNAME 目标地址，到 Cloudflare 添加（或修正）`hub` 的 CNAME 指向该地址。
4. 等 EdgeOne 域名管理列表里状态显示“CNAME 已生效”。
5. 检查 HTTPS：进入“域名管理 → HTTPS 配置”，如果平台没有自动配置证书，选择“EdgeOne 自动完成免费证书申请、部署以及续签”，等证书状态变为已生效（通常几分钟）。
6. 生效后用手机流量（不是 Wi-Fi）和家里宽带分别打开 `https://hub.zal.best`。
7. 打开同步界面看“连接耗时/诊断”面板，确认首页和各阶段时间。

SSL 证书免费，但不要默认它已经自动签发：官方 FAQ 写的是“自定义域名 + DNS 配置完成后自动提供证书”，而详细 HTTPS 文档说明 Makers 不会自动分配证书，需要到“域名管理 → HTTPS 配置”里选择“EdgeOne 自动完成免费证书申请、部署以及续签”。以详细文档为准，证书无需自购。

## 六、第四步：短码信令中继的国内替代

现状：`signaling/` 是 Cloudflare Worker + Durable Object，部署在 `workers.dev`，国内访问会明显慢。短码只是交换 SDP/ICE 配对信息，不传输用户数据。

国内化有两种做法：

- 方案 A（推荐，上线稳定后做）：EdgeOne Pages Functions + 数据库，或 CloudBase 云函数 + 数据库。把 `signaling/src` 里 `relay-room.js` 的房间状态从 Durable Object 改成“函数 + 数据库”，API 路径保持不变：`/api/room`、`/api/room/:code/join`、`/send`、`/poll`、`/delete`、`/health`。前端只需要改 `site/index.html` 里的 `shortRelayUrl()`，把 URL 换成国内地址，再重新部署。
- 方案 B（先上线不阻塞）：暂时继续用 Cloudflare relay，用 `?relay=URL` 临时切换测试国内中继地址，观察诊断面板里的信令耗时，等方案 A 做完再切换。

注意：EdgeOne 自带 KV 官方标注“60s 最终一致”，实时信令不能依赖 KV 存消息；中继状态优先放 CloudBase 数据库，或先用 EdgeOne Blob 做读后立即写的实测再定。

## 七、费用与时间

| 事项 | 费用 | 时间 |
| --- | --- | --- |
| EdgeOne Makers 静态托管 | 免费 | 部署即生效 |
| `hub.zal.best` 子域名 + CNAME | 免费 | 最长 48 小时生效 |
| SSL 证书 | 免费 | 在 HTTPS 配置开启 EdgeOne 免费申请/续签，通常几分钟 |
| CloudBase 免费体验版环境 | 免费（3000 资源点/月，以官方控制台为准） | 创建即用 |
| 后续 ICP 备案 | 域名几十元/年 + 备案资源 110 元/60 个月 | 7-20 个工作日 |

## 八、现在按这个顺序做

1. EdgeOne Makers 建项目，部署 `site/`。
2. EdgeOne 添加自定义域名 `hub.zal.best`，拿到验证记录和 CNAME 目标。
3. Cloudflare 添加 `hub` 的 CNAME（顺便完成验证记录）。
4. 回 EdgeOne 等生效，用手机流量验证 `https://hub.zal.best`。
5. 后面再做：信令中继国内化（第六步）→ 新域名备案切大陆区（战略文档）。

## 九、一键自查

仓库里已附验证脚本，随时可跑：

``powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/check-deployment.ps1
``

它会依次检查：zal.best 的 NS、hub.zal.best 的 CNAME、https://hub.zal.best 首页 HTTP 状态、短码信令 /health。现在跑的结果是：NS 指向 Cloudflare、hub.zal.best 尚未配置、信令健康检查通过；等你完成第五步再跑一次，前三项应全部变绿。
