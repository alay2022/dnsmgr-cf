-- ============================================================
-- DNSMGR-CF 增量迁移 0008：移除机场订阅功能，节点加测速结果持久化
-- ============================================================

-- 节点测速结果持久化，这样卡片上能一直显示上次测速结果，不用每次都重新测
ALTER TABLE misub_nodes ADD COLUMN last_latency_ms INTEGER;
ALTER TABLE misub_nodes ADD COLUMN last_tested_at INTEGER;

-- 移除机场订阅功能：订阅组不再关联订阅，只关联手动节点
ALTER TABLE misub_profiles DROP COLUMN subscription_ids;
DROP TABLE IF EXISTS misub_subscriptions;
