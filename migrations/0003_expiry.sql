-- ============================================================
-- DNSMGR-CF 增量迁移 0003：域名到期时间 / 证书颁发机构信息
-- ============================================================

-- 域名注册到期时间（通过 whois/RDAP 查询获取，手动或定时刷新，不是每次都实时查）
ALTER TABLE domains ADD COLUMN whois_expires_at INTEGER;
ALTER TABLE domains ADD COLUMN whois_checked_at INTEGER;

-- 证书颁发机构（签发成功时由 GitHub Actions 用 Node 的 X509Certificate 解析出来一并回传）
ALTER TABLE ssl_certs ADD COLUMN issuer TEXT;
