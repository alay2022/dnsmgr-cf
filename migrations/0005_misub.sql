-- ============================================================
-- DNSMGR-CF 增量迁移 0005：MiSub 节点/订阅/分组管理
-- 参考 MiSub (https://github.com/CrazyForks/MiSub) 的核心数据模型，简化实现：
-- 手动节点 + 机场订阅 分离管理，组合成"分组(Profile)"对外生成订阅链接。
-- 权限模型跟 dns_providers 一致：owner_user_id 归属，管理员可查看全部。
-- ============================================================

CREATE TABLE IF NOT EXISTS misub_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL,
  name TEXT,
  url TEXT NOT NULL,              -- 节点链接，如 vmess://... vless://... trojan://... ss://... hysteria2://...
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS misub_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL,
  name TEXT,
  url TEXT NOT NULL,              -- 机场订阅地址
  enabled INTEGER NOT NULL DEFAULT 1,
  node_count INTEGER,             -- 上次刷新时解析出的节点数
  traffic_used INTEGER,           -- 已用流量(字节)，从响应头 subscription-userinfo 解析
  traffic_total INTEGER,          -- 总流量(字节)
  expires_at INTEGER,             -- 到期时间(秒级时间戳)，同上解析
  last_checked_at INTEGER,
  last_error TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS misub_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  share_token TEXT NOT NULL UNIQUE,     -- 公开订阅链接用的随机token，客户端直接拿这个链接订阅，不需要登录
  subscription_ids TEXT NOT NULL DEFAULT '[]',  -- JSON数组，包含哪些机场订阅
  node_ids TEXT NOT NULL DEFAULT '[]',           -- JSON数组，包含哪些手动节点
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
