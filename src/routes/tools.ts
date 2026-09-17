import { Hono } from "hono";
import type { Env } from "../types";
import { requireAuth } from "../middleware/auth";
import { safeJson } from "../utils/http";
import { lookupWhois } from "../utils/whois";

export const toolsRoutes = new Hono<{ Bindings: Env }>();
toolsRoutes.use("*", requireAuth);

/**
 * DNS查询：GET /api/tools/dns-lookup?domain=example.com&type=A
 * 通过 Cloudflare 的 DoH（DNS over HTTPS）服务查询，服务端代理避免浏览器端CORS问题。
 */
toolsRoutes.get("/dns-lookup", async (c) => {
  const domain = c.req.query("domain");
  const type = c.req.query("type") || "A";
  if (!domain) return c.json({ error: "缺少domain参数" }, 400);

  const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`, {
    headers: { accept: "application/dns-json" },
  });
  const data = await safeJson(res, "DNS查询");
  return c.json({
    domain,
    type,
    status: data.Status,
    answers: (data.Answer || []).map((a: any) => ({ name: a.name, type: a.type, ttl: a.TTL, data: a.data })),
  });
});

/**
 * Whois查询：GET /api/tools/whois?domain=example.com
 * 通过 RDAP（新一代Whois标准协议，免费无需Key）查询，逻辑见 utils/whois.ts。
 */
toolsRoutes.get("/whois", async (c) => {
  const domain = c.req.query("domain");
  if (!domain) return c.json({ error: "缺少domain参数" }, 400);
  try {
    return c.json(await lookupWhois(domain));
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

/**
 * 证书检查：GET /api/tools/cert-check?domain=example.com
 * 通过 crt.sh（Certificate Transparency日志公开查询接口，免费无需Key）查询该域名最近签发的证书记录。
 */
toolsRoutes.get("/cert-check", async (c) => {
  const domain = c.req.query("domain");
  if (!domain) return c.json({ error: "缺少domain参数" }, 400);

  const res = await fetch(`https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`);
  if (!res.ok) return c.json({ error: `crt.sh查询失败 (HTTP ${res.status})` }, 502);
  const text = await res.text();
  let data: any[];
  try {
    data = JSON.parse(text);
  } catch {
    return c.json({ error: "crt.sh返回了非预期内容，可能查询过于频繁被限流，请稍后重试" }, 502);
  }

  // 按签发时间倒序，去重，只保留最近10条
  const sorted = data
    .sort((a, b) => new Date(b.entry_timestamp).getTime() - new Date(a.entry_timestamp).getTime())
    .slice(0, 10)
    .map((r) => ({
      commonName: r.common_name,
      issuer: r.issuer_name,
      notBefore: r.not_before,
      notAfter: r.not_after,
      entryTimestamp: r.entry_timestamp,
    }));

  return c.json({ domain, certificates: sorted });
});
