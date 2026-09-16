-- ============================================================
-- 0002: 域名排序 + 解析记录备注 + 收藏夹
-- ============================================================

ALTER TABLE domains ADD COLUMN sort_order INTEGER DEFAULT 0;

-- 解析记录本身存在各云厂商那边，不在本地数据库，所以"备注"用一张本地表按
-- (domain_id, record_id) 关联存储，record_id 是各平台适配器返回的记录ID。
CREATE TABLE IF NOT EXISTS record_remarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id INTEGER NOT NULL,
  record_id TEXT NOT NULL,
  remark TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE(domain_id, record_id)
);

-- 收藏夹（后续批次会用到，这里先建表）
CREATE TABLE IF NOT EXISTS user_favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  domain_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, domain_id)
);

-- 给已有域名一个初始排序值（按当前id顺序）
UPDATE domains SET sort_order = id WHERE sort_order = 0 OR sort_order IS NULL;
