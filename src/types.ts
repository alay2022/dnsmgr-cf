export interface Env {
  DB: D1Database;
  JWT_SECRET: string;
  ACME_ACCOUNT_EMAIL: string;
  APP_NAME: string;
  JWT_EXPIRE_SECONDS: string;
  APPLINK_EXPIRE_SECONDS: string;
  ENCRYPT_KEY?: string; // AES-GCM 密钥（base64），用于 provider 凭据加密；建议用 secret 单独设置
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
}

export interface DnsDomain {
  domainName: string;
  status?: string;
}
