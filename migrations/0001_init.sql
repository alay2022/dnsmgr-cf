-- ============================================================
-- DNSMGR-CF 初始化建表脚本 (Cloudflare D1 / SQLite)
-- ============================================================

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,     -- PBKDF2 派生后的哈希，格式 iter$salt$hash（均为hex）
  role TEXT NOT NULL DEFAULT 'user', -- 'admin' | 'user'
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'disabled'
  email TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 解析平台账号（存储各云厂商的 AK/SK / Token 等，加密后存储密文）
CREATE TABLE IF NOT EXISTS dns_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,               -- 用户自定义备注名
  type TEXT NOT NULL,               -- aliyun|tencent|huaweicloud|baiducloud|west|volcengine|dnsla|cloudflare|namesilo|powerdns
  credentials TEXT NOT NULL,        -- JSON字符串，AES-GCM加密后的密文（见 utils/crypto.ts）
  owner_user_id INTEGER NOT NULL,   -- 归属的用户（一般是admin录入）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES users(id)
);

-- 域名（从各平台同步或手动添加）
CREATE TABLE IF NOT EXISTS domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL,
  domain_name TEXT NOT NULL,
  remark TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  synced_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (provider_id) REFERENCES dns_providers(id),
  UNIQUE(provider_id, domain_name)
);

-- 用户-域名 权限表（细粒度授权，可读/可写）
CREATE TABLE IF NOT EXISTS user_domain_perms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  domain_id INTEGER NOT NULL,
  perm TEXT NOT NULL DEFAULT 'readwrite', -- 'readonly' | 'readwrite'
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (domain_id) REFERENCES domains(id),
  UNIQUE(user_id, domain_id)
);

-- SSL 证书
CREATE TABLE IF NOT EXISTS ssl_certs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id INTEGER NOT NULL,
  common_name TEXT NOT NULL,
  sans TEXT,                        -- JSON数组，多域名SAN
  ca TEXT NOT NULL DEFAULT 'letsencrypt',
  cert_pem TEXT,
  key_pem TEXT,                     -- 建议客户端下载后自行妥善保管；如需更高安全性可只存证书链不存私钥明文
  status TEXT NOT NULL DEFAULT 'pending', -- pending|issued|failed|expired
  issued_at INTEGER,
  expires_at INTEGER,
  auto_renew INTEGER NOT NULL DEFAULT 1,
  deploy_targets TEXT,               -- JSON: 自动部署目标（如上传到某CDN/服务器的webhook）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (domain_id) REFERENCES domains(id)
);

-- 通知渠道配置
CREATE TABLE IF NOT EXISTS notify_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,   -- email|wechat_mp|telegram|dingtalk|feishu|wecom|serverchan
  config TEXT NOT NULL, -- JSON字符串（含密文）
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- API Key（用于开放API：获取登录直达链接等，供IDC系统对接）
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL,
  remark TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 操作日志
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);

-- ============================================================
-- 管理员账号 seed：admin / admin
-- 下面这条哈希是 PBKDF2(SHA-256, 100000次, salt="dnsmgrcf-default-salt")
-- 对明文 "admin" 的计算结果，格式：iterations$saltHex$hashHex，与 src/utils/crypto.ts 中
-- hashPassword()/verifyPassword() 的算法严格一致，部署后可直接用 admin/admin 登录。
-- 强烈建议首次登录后立刻在「个人设置」里修改密码。
-- ============================================================
INSERT OR IGNORE INTO users (id, username, password_hash, role, status, created_at, updated_at)
VALUES (
  1,
  'admin',
  '100000$646e736d677263662d64656661756c742d73616c74$a5f456be03e632877430be115ef5d2a456db1bfb1a2b2bfc4bcf55f392da93bb',
  'admin',
  'active',
  strftime('%s','now'),
  strftime('%s','now')
);
