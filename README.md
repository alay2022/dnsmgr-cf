# DNSMGR-CF

基于 **Cloudflare Workers + D1** 实现的多平台域名解析统一管理系统（参考 [netcccyun/dnsmgr](https://github.com/netcccyun/dnsmgr) 的功能定位，架构改为 Cloudflare 原生技术栈）。

## 技术栈

- **运行时**：Cloudflare Workers（HTTP 路由用 [Hono](https://hono.dev)）
- **数据库**：Cloudflare D1（SQLite）
- **定时任务**：GitHub Actions `schedule`（证书到期检查 / 自动续签，详见下方「证书签发架构」章节）
- **静态前端**：Cloudflare Pages（`public/` 目录，纯 HTML+JS 单页应用，无需构建工具）
- **鉴权**：手写 JWT（HMAC-SHA256，WebCrypto 实现，无第三方依赖）
- **密码**：PBKDF2（WebCrypto）加盐哈希

> 说明：一个 Workers 项目即可同时提供 API 和（如果你愿意）静态资源，也可以把 `public/` 单独部署到 Pages，二者通过 `API_BASE` 配置对接。本骨架默认按「Workers 出 API，Pages 出前端」的分离方式给出，方便各自独立扩缩容。

## 目录结构

```
dnsmgr-cf/
├── wrangler.toml            # Workers 配置（含 D1 绑定、Cron）
├── migrations/0001_init.sql # D1 建表 SQL
├── migrations/0002_features.sql # 域名排序/记录备注/收藏夹 增量迁移
├── src/
│   ├── index.ts             # Hono 入口，路由汇总
│   ├── types.ts             # 公共类型
│   ├── db.ts                # D1 访问封装
│   ├── github.ts            # 触发 GitHub Actions workflow_dispatch
│   ├── middleware/auth.ts   # JWT 校验 + 权限校验中间件
│   ├── utils/crypto.ts      # 密码哈希、JWT 签发/校验、签名工具(HMAC/SHA)
│   ├── providers/           # 解析平台适配层（统一接口）
│   │   ├── interface.ts     # DnsProvider 接口定义
│   │   ├── registry.ts      # 按 provider 类型创建实例
│   │   ├── cloudflare.ts    # ✅ 完整实现
│   │   ├── dnspod.ts        # ✅ 完整实现（腾讯云 DNSPod）
│   │   ├── aliyun.ts        # ✅ 完整实现（阿里云 DNS，含签名）
│   │   ├── namesilo.ts      # ✅ 完整实现
│   │   ├── powerdns.ts      # ✅ 完整实现
│   │   ├── huaweicloud.ts   # 🧩 骨架+签名工具，待补 AK/SK 请求细节
│   │   ├── baiducloud.ts    # 🧩 骨架，待补
│   │   ├── west.ts          # 🧩 西部数码，骨架，待补
│   │   ├── volcengine.ts    # 🧩 火山引擎，骨架，待补
│   │   └── dnsla.ts         # 🧩 骨架，待补
│   ├── notify/channels.ts   # 邮件/微信公众号/Telegram/钉钉/飞书/企业微信/Server酱
│   ├── acme/client.ts       # ACME v2 DNS-01 客户端（Let's Encrypt）
│   └── routes/
│       ├── auth.ts          # 登录、修改密码
│       ├── users.ts         # 用户管理 + 权限分配（管理员）
│       ├── providers.ts     # 解析平台账号（AK/SK等）管理
│       ├── domains.ts       # 域名列表（从各平台同步）
│       ├── records.ts       # 解析记录增删改查
│       ├── applink.ts       # 「获取域名登录直达链接」API，供 IDC 系统对接
│       ├── ssl.ts           # 证书申请/续签/下载（实际签发已转交GitHub Actions）
│       ├── notify.ts        # 通知渠道配置与测试发送
│       └── ci.ts            # 供 GitHub Actions 调用：CI token签发、签发结果回调、待续签列表
│       ├── overview.ts      # 概览页统计数据
│       └── tools.ts         # 工具箱：DNS查询/whois查询/证书透明度日志查询
├── scripts/                 # GitHub Actions 里跑的证书签发脚本（Node.js，用 tsx 直接运行，无需编译）
│   ├── lib.ts                # 共用逻辑：包装Worker的DNS记录API为DnsProvider、执行ACME签发
│   ├── issue-cert.ts         # 单次签发入口（workflow_dispatch调用）
│   └── renew-certs.ts        # 批量续签入口（schedule定时调用）
├── .github/workflows/
│   ├── issue-cert.yml        # 单次签发 workflow
│   └── renew-certs.yml       # 每日定时续签 workflow
└── public/                  # 极简管理后台前端
    ├── index.html
    ├── app.js
    └── style.css
```

## 部署步骤

```bash
npm install
npx wrangler login

# 2. 创建 D1 数据库
npx wrangler d1 create dnsmgr

# 把返回的 database_id 填入 wrangler.toml 的 [[d1_databases]]

# 3. 执行建表（两个迁移文件都要按顺序执行）
npx wrangler d1 execute dnsmgr --file=./migrations/0001_init.sql --remote
npx wrangler d1 execute dnsmgr --file=./migrations/0002_features.sql --remote
# 0002_features.sql 新增了域名排序 / 解析记录备注 / 收藏夹功能用到的字段和表，
# 如果你是老项目升级（之前已经执行过0001但没执行过0002），务必补上这一条。

# 3. 设置必需的密钥（JWT 签名密钥、ACME 账户邮箱等）
npx wrangler secret put JWT_SECRET
npx wrangler secret put ACME_ACCOUNT_EMAIL

# 4. 部署 Workers（API）
npx wrangler deploy

# 5. 部署前端到 Pages（把 public/ 作为发布目录，设置环境变量 API_BASE 指向上面 Workers 的域名）
npx wrangler pages deploy public --project-name dnsmgr-cf
```

首次启动会在 `users` 表里自动 seed 管理员账号：

```
用户名: admin
密码:   admin
```

**务必登录后立即修改密码。**

## MiSub 订阅管理（附加功能，与DNS管理无关）

参考 [MiSub](https://github.com/imzyb/MiSub) 做的简化版代理节点/订阅管理，跟本项目其余功能完全独立，只是共用同一套账号体系和界面框架：

- **订阅域名**：默认订阅链接用 Worker 自己的地址；想用短域名，需要先在 **Cloudflare Dashboard → Workers & Pages → 这个Worker → Settings → Domains & Routes → Add Custom Domain** 绑定一个你名下、DNS托管在Cloudflare的域名，绑定成功后回到本系统「MiSub 订阅管理」页面顶部的"订阅域名"里填上同一个域名（仅管理员可改），之后生成的链接就会是 `https://你的域名/自定义ID` 这种短链接形式
- **我的订阅组**：卡片式自适应网格（一行放几个由屏幕宽度自动决定），支持拖拽排序；每个分组可以设置**自定义ID**（不填则用随机字符串），生成对外的订阅链接；单独开关"启用状态"；点小眼睛图标能看最近的访问日志（IP+客户端）；点复制图标一键复制链接、点二维码图标生成二维码扫码订阅
- **订阅组内节点排序**：编辑订阅组时，右侧"已选节点"列表支持拖拽排序，这个顺序就是生成的订阅链接里节点的实际先后顺序
- **手动节点**：卡片式自适应网格，支持拖拽排序（只在"全部"分组视图下才能拖，切到某个具体分组筛选时为避免打乱全局排序禁用了拖拽）、分组标签筛选、批量勾选删除（全选和批量删除按钮在卡片下方）；鼠标悬停节点卡片会显示"测速/编辑/删除"三个图标；新增改成弹窗式，支持单条编辑也支持多行粘贴批量导入
- **测速**：测的是能否建立TCP连接及握手耗时，不是真实代理转发速度（Workers 没法代理转发用户流量来测真实带宽）；部分机场会屏蔽云服务商出口IP，测出"超时"不代表节点真的不可用，仅供参考；结果会持久化显示在节点卡片上
- **订阅导入为节点**：把一个外部机场订阅地址的内容直接拆开，逐条导入成手动节点（一次性拍平，导入后跟原订阅没有关联）
- 默认只支持输出通用(base64)格式；如果想要 Clash/Surge/singbox 专属格式，需要自己搭一个 [subconverter](https://github.com/tindy2013/subconverter) 服务，配置到 `wrangler.toml` 的 `MISUB_SUBCONVERTER_URL`
- 权限模型跟"解析平台账号"一致：管理员能看到所有人的节点/分组，普通用户只能看到和管理自己的

> 这一版把独立的"机场订阅"管理功能去掉了（之前版本里可以单独添加/刷新机场订阅、在订阅组里勾选组合），现在订阅组只能组合手动节点。如果需要用某个机场的订阅，用上面的"订阅导入为节点"一次性拆开导入即可。

## 证书签发架构：GitHub Actions

**从这个版本开始，证书签发/续签不再由 Cloudflare Workers 自己执行，而是搬到了 GitHub Actions 里跑。** 原因：

1. Cloudflare Workers 访问 `acme-v02.api.letsencrypt.org` 有个平台级的已知问题，请求经常返回525（SSL握手失败），社区多年未解决；
2. 即便换成 ZeroSSL 绕开了525，Workers **Free 计划每次请求只有10ms CPU时间**，ACME协议里密集的ECDSA签名运算经常会把这个配额打爆，导致证书在CA那边其实已经签发成功，但 Worker 执行被强制中断、数据库状态永远停在 `pending`。

GitHub Actions 用的是普通的 Ubuntu 虚拟机，没有这两个限制，和原版 `netcccyun/dnsmgr` 部署在普通服务器上跑 PHP 是一个道理。

### 架构

```
浏览器点"申请证书"
   → Worker: 插入一条 pending 记录，调用 GitHub API 触发 issue-cert.yml
      → GitHub Actions: 用 scripts/issue-cert.ts 完成整个ACME流程
         - 调 Worker 的 /api/open/ci-token 换一个域名限定的临时token
         - 用这个token调 Worker 的 /api/domains/:id/records 接口增删TXT记录（复用Worker里已经写好的10个解析平台适配器）
         - 直接和 Let's Encrypt / ZeroSSL 对话（不经过Workers，没有CPU限制）
         - 签发完成后回调 Worker 的 /api/ci/certs/:id/complete，写回数据库 + 触发通知
浏览器每隔5秒轮询证书列表，状态从 pending 变成 issued/failed 后弹提示
```

续签则由 `.github/workflows/renew-certs.yml` 的 `schedule` 每天自动跑一次（不再依赖 Cloudflare Cron Trigger），逻辑跟手动申请一致，只是批量处理 `/api/ci/due-for-renewal` 返回的到期列表。

### 配置步骤

**1. 创建 GitHub Personal Access Token（供 Worker 触发 workflow 用）**

去 GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens，创建一个只对 `dnsmgr-cf` 这个仓库有权限的token，权限勾选 **Actions: Read and write**。复制生成的token。

**2. 生成一个共享密钥（供 GitHub Actions 回调 Worker 用）**

随便生成一串随机字符串即可，比如：
```bash
openssl rand -hex 32
```

**3. 在 Cloudflare Worker 里配置 secret**

```bash
npx wrangler secret put GITHUB_TOKEN          # 第1步生成的token
npx wrangler secret put CI_CALLBACK_SECRET    # 第2步生成的随机字符串
```

`wrangler.toml` 里的 `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_REF` 已经按你的仓库预填好了，如果不对自己改一下。

**4. 在前端"开放API / 登录直达链接"页面生成一个 API Key**

登录管理后台 → 开放API / 登录直达链接 → 生成新的 API Key，记下 `apiKey` 和 `apiSecret`（只显示一次）。这组凭据 GitHub Actions 会用来获取操作解析记录的权限，建议用管理员账号生成（不受单个域名权限限制）。

**5. 在 GitHub 仓库里配置 Secrets**

进入 GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret，依次添加：

| Secret 名 | 值 |
|---|---|
| `WORKER_BASE_URL` | 你的Worker地址，如 `https://dnsmgr-cf.alay.workers.dev` |
| `DNSMGR_API_KEY` | 第4步生成的 apiKey |
| `DNSMGR_API_SECRET` | 第4步生成的 apiSecret |
| `CI_CALLBACK_SECRET` | 第2步生成的随机字符串（必须和Worker里配置的完全一致） |
| `ACME_ACCOUNT_EMAIL` | 你的邮箱，ACME账户注册用 |

**证书颁发机构二选一**（GitHub Actions 环境下 Let's Encrypt 应该不会再报525了，可以直接用，更简单）：

- 用 **Let's Encrypt**（推荐，更简单）：以上5个Secret配置完就够了，不用再加下面这几个
- 用 **ZeroSSL**（如果你之前已经申请了EAB凭据，想继续用）：额外加这三个Secret
  | Secret 名 | 值 |
  |---|---|
  | `ACME_DIRECTORY_URL` | `https://acme.zerossl.com/v2/DV90` |
  | `ACME_EAB_KID` | 你在ZeroSSL开发者后台生成的 EAB Kid |
  | `ACME_EAB_HMAC_KEY` | 你在ZeroSSL开发者后台生成的 EAB HMAC Key |

**6. 部署**

```bash
npx wrangler deploy
git add .
git commit -m "feat: 证书签发迁移到GitHub Actions"
git push
```

配置完成后回网页测试一次"申请证书"，这次应该几十秒到1~2分钟内就能看到状态变成 `issued`，不再有525或pending卡死的问题。



## 核心功能对应关系

| 需求 | 实现位置 |
|---|---|
| 多用户 + 分权限 | `users`/`user_domain_perms` 表 + `middleware/auth.ts` |
| 各平台解析统一管理 | `providers/*` 适配器 + `routes/domains.ts` `routes/records.ts` |
| 域名独立登录直达链接 API | `routes/applink.ts`（签发一次性/限时 token，IDC 系统跳转即登录并锁定到该域名的权限范围） |
| SSL 证书申请与自动部署 | `acme/client.ts`（ACME协议核心，供Worker和GitHub Actions共用）+ `routes/ssl.ts`+`routes/ci.ts`（Worker侧）+ `scripts/*.ts`+`.github/workflows/*.yml`（实际签发，见下方「证书签发架构」章节） |
| 多通知渠道 | `notify/channels.ts` + `routes/notify.ts` |
| 管理员 admin/admin | `migrations/0001_init.sql` 中 seed，密码为 PBKDF2 哈希后写入 |

## 尚未完整实现的部分（按你的实际账号资料 30 分钟内可补齐）

华为云 / 百度智能云 / 西部数码 / 火山引擎 / DNSLA 五个适配器目前是**规范骨架**：接口方法签名、认证方式说明、请求 URL 占位都已给出，只是没有针对每家私有签名算法的完整实现（华为云需要 SDK 风格的 AK/SK 派生签名，百度云需要 bce-auth-v1，西部数码是老式 MD5 token 签名，火山引擎是火山自有 HMAC-SHA256，DNSLA 是 APIKey+Secret 的 HMAC）。这些我在 `providers/interface.ts` 里统一抽象成了 `listRecords/createRecord/updateRecord/deleteRecord/listDomains` 五个方法，其余平台都是照此实现的，可以直接参考 `aliyun.ts`（同样是 AK/SK HMAC 签名）来补全。
