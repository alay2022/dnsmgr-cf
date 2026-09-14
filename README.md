# DNSMGR-CF

基于 **Cloudflare Workers + D1** 实现的多平台域名解析统一管理的系统。

## 技术栈

- **运行时**：Cloudflare Workers（HTTP 路由用 [Hono](https://hono.dev)）
- **数据库**：Cloudflare D1（SQLite）
- **定时任务**：Cloudflare Cron Triggers（证书到期检查 / 自动续签）
- **静态前端**：Cloudflare Pages（`public/` 目录，纯 HTML+JS 单页应用，无需构建工具）
- **鉴权**：手写 JWT（HMAC-SHA256，WebCrypto 实现，无第三方依赖）
- **密码**：PBKDF2（WebCrypto）加盐哈希

> 说明：一个 Workers 项目即可同时提供 API 和（如果你愿意）静态资源，也可以把 `public/` 单独部署到 Pages，二者通过 `API_BASE` 配置对接。本骨架默认按「Workers 出 API，Pages 出前端」的分离方式给出，方便各自独立扩缩容。

## 目录结构

```
dnsmgr-cf/
├── wrangler.toml            # Workers 配置（含 D1 绑定、Cron）
├── migrations/0001_init.sql # D1 建表 SQL
├── src/
│   ├── index.ts             # Hono 入口，路由汇总
│   ├── types.ts             # 公共类型
│   ├── db.ts                # D1 访问封装
│   ├── cron.ts              # 定时任务：证书续签、到期提醒
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
│       ├── ssl.ts           # 证书申请/续签/下载
│       └── notify.ts        # 通知渠道配置与测试发送
└── public/                  # 极简管理后台前端
    ├── index.html
    ├── app.js
    └── style.css
```

## 部署步骤

```bash
npm install
npx wrangler login

# 1. 创建 D1 数据库
npx wrangler d1 create dnsmgr

# 把返回的 database_id 填入 wrangler.toml 的 [[d1_databases]]

# 2. 执行建表
npx wrangler d1 execute dnsmgr --file=./migrations/0001_init.sql --remote

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

## 核心功能对应关系

| 需求 | 实现位置 |
|---|---|
| 多用户 + 分权限 | `users`/`user_domain_perms` 表 + `middleware/auth.ts` |
| 各平台解析统一管理 | `providers/*` 适配器 + `routes/domains.ts` `routes/records.ts` |
| 域名独立登录直达链接 API | `routes/applink.ts`（签发一次性/限时 token，IDC 系统跳转即登录并锁定到该域名的权限范围） |
| SSL 证书申请与自动部署 | `acme/client.ts` + `routes/ssl.ts` + `cron.ts`（DNS-01 挑战通过 provider 适配器自动写入/清理 TXT 记录） |
| 多通知渠道 | `notify/channels.ts` + `routes/notify.ts` |
| 管理员 admin/admin | `migrations/0001_init.sql` 中 seed，密码为 PBKDF2 哈希后写入 |

## 尚未完整实现的部分（按你的实际账号资料 30 分钟内可补齐）

华为云 / 百度智能云 / 西部数码 / 火山引擎 / DNSLA 五个适配器目前是**规范骨架**：接口方法签名、认证方式说明、请求 URL 占位都已给出，只是没有针对每家私有签名算法的完整实现（华为云需要 SDK 风格的 AK/SK 派生签名，百度云需要 bce-auth-v1，西部数码是老式 MD5 token 签名，火山引擎是火山自有 HMAC-SHA256，DNSLA 是 APIKey+Secret 的 HMAC）。这些我在 `providers/interface.ts` 里统一抽象成了 `listRecords/createRecord/updateRecord/deleteRecord/listDomains` 五个方法，其余平台都是照此实现的，可以直接参考 `aliyun.ts`（同样是 AK/SK HMAC 签名）来补全。
