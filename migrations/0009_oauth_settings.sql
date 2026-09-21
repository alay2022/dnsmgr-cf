-- ============================================================
-- DNSMGR-CF 增量迁移 0009：第三方登录配置从 wrangler.toml 迁移到数据库
-- ============================================================
CREATE TABLE IF NOT EXISTS oauth_provider_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL UNIQUE,     -- github | google | nodeloc
  label TEXT NOT NULL,               -- 登录按钮显示文字
  enabled INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  client_id TEXT,
  client_secret TEXT,                -- AES-GCM加密存储（跟解析平台AK/SK用同一套加密逻辑）
  authorize_url TEXT,
  token_url TEXT,
  userinfo_url TEXT,
  scope TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO oauth_provider_configs
  (provider, label, enabled, sort_order, authorize_url, token_url, userinfo_url, scope, created_at, updated_at)
VALUES
  ('github', 'GitHub', 0, 1, 'https://github.com/login/oauth/authorize', 'https://github.com/login/oauth/access_token', 'https://api.github.com/user', 'read:user', strftime('%s','now'), strftime('%s','now')),
  ('google', 'Google', 0, 2, 'https://accounts.google.com/o/oauth2/v2/auth', 'https://oauth2.googleapis.com/token', 'https://www.googleapis.com/oauth2/v3/userinfo', 'openid email profile', strftime('%s','now'), strftime('%s','now')),
  ('nodeloc', 'NodeLoc', 0, 3, 'https://www.nodeloc.com/oauth-provider/authorize', 'https://www.nodeloc.com/oauth-provider/token', 'https://www.nodeloc.com/oauth-provider/userinfo', 'openid profile email', strftime('%s','now'), strftime('%s','now'));
