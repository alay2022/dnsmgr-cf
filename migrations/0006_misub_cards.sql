-- ============================================================
-- DNSMGR-CF 增量迁移 0006：MiSub 卡片化改造
-- ============================================================

-- 订阅组（profiles）：排序、启用开关、是否公开访问、被订阅次数
ALTER TABLE misub_profiles ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE misub_profiles ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE misub_profiles ADD COLUMN is_public INTEGER NOT NULL DEFAULT 1;
ALTER TABLE misub_profiles ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;
UPDATE misub_profiles SET sort_order = id WHERE sort_order = 0;

-- 手动节点：分组标签
ALTER TABLE misub_nodes ADD COLUMN group_name TEXT;

-- 订阅组访问日志（被哪个客户端、什么时间订阅过），只保留最近的记录，前端展示用
CREATE TABLE IF NOT EXISTS misub_access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_misub_access_log_profile ON misub_access_log(profile_id, created_at DESC);
