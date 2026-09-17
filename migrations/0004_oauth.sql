-- ============================================================
-- DNSMGR-CF 增量迁移 0004：第三方登录绑定（GitHub / Google / 通用OAuth2如NodeLoc）
-- ============================================================
CREATE TABLE IF NOT EXISTS oauth_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL,           -- github | google | nodeloc
  provider_user_id TEXT NOT NULL,   -- 第三方平台侧的用户ID
  provider_username TEXT,           -- 第三方平台的用户名/昵称，仅用于展示
  created_at INTEGER NOT NULL,
  UNIQUE(provider, provider_user_id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
