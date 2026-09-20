-- ============================================================
-- DNSMGR-CF 增量迁移 0007：MiSub 自定义订阅域名 + 短链接ID
-- ============================================================

-- 订阅组支持自定义短ID（不填就还是用原来的随机token）
ALTER TABLE misub_profiles ADD COLUMN custom_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_misub_profiles_custom_id ON misub_profiles(custom_id);

-- MiSub 全局设置（目前只有一个字段：订阅链接用的自定义域名），单行存储
CREATE TABLE IF NOT EXISTS misub_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  domain TEXT,
  updated_at INTEGER
);
INSERT OR IGNORE INTO misub_settings (id, domain, updated_at) VALUES (1, NULL, strftime('%s','now'));
