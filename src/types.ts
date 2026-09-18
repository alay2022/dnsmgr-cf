export interface Env {
  DB: D1Database;
  JWT_SECRET: string;
  ACME_ACCOUNT_EMAIL: string;
  ACME_DIRECTORY_URL?: string; // 可选，不填默认用 Let's Encrypt 生产环境；如遇525问题可切换为 ZeroSSL 等
  ACME_EAB_KID?: string; // ZeroSSL等要求EAB的CA需要，从其开发者后台获取
  ACME_EAB_HMAC_KEY?: string;
  // GitHub Actions 证书签发相关（把ACME签发流程搬到GitHub Actions里跑，绕开Workers的CPU时间限制）：
  GITHUB_TOKEN?: string; // GitHub PAT，需要 repo + workflow 权限，用于触发 workflow_dispatch
  GITHUB_OWNER?: string; // 仓库拥有者，如 alay2022
  GITHUB_REPO?: string; // 仓库名，如 dnsmgr-cf
  GITHUB_REF?: string; // 触发的分支，默认 main
  CI_CALLBACK_SECRET?: string; // GitHub Actions 回调本项目API时用的共享密钥
  CI_TOKEN_EXPIRE_SECONDS?: string; // CI用的域名限定token有效期，默认1800秒（30分钟）
  APP_NAME: string;
  JWT_EXPIRE_SECONDS: string;
  APPLINK_EXPIRE_SECONDS: string;
  ENCRYPT_KEY?: string; // AES-GCM 密钥（base64），用于 provider 凭据加密；建议用 secret 单独设置
  // 第三方登录（GitHub / Google 是标准OAuth2；NodeLoc 端点因平台特殊做成通用可配置）
  OAUTH_REDIRECT_BASE?: string; // 本Worker自己的地址，如 https://dnsmgr-cf.alay.workers.dev
  FRONTEND_BASE?: string; // 前端Pages地址，登录完成后跳回这里
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  NODELOC_OAUTH_CLIENT_ID?: string;
  NODELOC_OAUTH_CLIENT_SECRET?: string;
  NODELOC_OAUTH_AUTHORIZE_URL?: string;
  NODELOC_OAUTH_TOKEN_URL?: string;
  NODELOC_OAUTH_USERINFO_URL?: string;
  NODELOC_OAUTH_SCOPE?: string;
  MISUB_SUBCONVERTER_URL?: string; // 可选，配置后支持把订阅转换为Clash/Surge/singbox等客户端专属格式
}

export type UserRole = "admin" | "user";
export type Perm = "readonly" | "readwrite";

export interface AuthUser {
  id: number;
  username: string;
  role: UserRole;
}

export interface JwtPayload {
  uid: number;
  username: string;
  role: UserRole;
  // 若为「域名登录直达链接」签发的受限token，会带上 scope
  scopeDomainId?: number;
  exp: number;
  iat: number;
}

export interface DnsRecord {
  id: string;          // 平台侧记录ID
  rr: string;           // 主机记录，如 www / @
  type: string;          // A/AAAA/CNAME/TXT/MX/NS...
  value: string;
  ttl: number;
  line?: string;         // 线路（部分平台支持，如默认/电信/联通）
  priority?: number;     // MX优先级
  status?: string;
  proxied?: boolean;     // 仅Cloudflare支持：是否启用CDN代理（橙色云朵）
  remark?: string;       // 本地备注，存储在本项目数据库，不属于任何解析平台的原始字段
}

export interface DnsDomain {
  domainName: string;
  status?: string;
}
