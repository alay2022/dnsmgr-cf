import { Hono } from "hono";
import type { Env, JwtPayload } from "../types";
import { requireAuth } from "../middleware/auth";
import { now } from "../db";

export const overviewRoutes = new Hono<{ Bindings: Env }>();
overviewRoutes.use("*", requireAuth);

overviewRoutes.get("/", async (c) => {
  const user = c.get("user") as JwtPayload;
  const isAdmin = user.role === "admin";

  const domainScope = isAdmin
    ? "1=1"
    : `d.id IN (SELECT domain_id FROM user_domain_perms WHERE user_id = ${user.uid})`;

  const domainCountRow = await c.env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM domains d WHERE ${domainScope}`
  ).first<{ cnt: number }>();

  const providerCountRow = isAdmin
    ? await c.env.DB.prepare("SELECT COUNT(*) as cnt FROM dns_providers").first<{ cnt: number }>()
    : { cnt: null };

  const certStatsRows = await c.env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM ssl_certs sc
     JOIN domains d ON d.id = sc.domain_id
     WHERE sc.status = 'issued' AND (${domainScope})`
  ).first<{ cnt: number }>();
  const certStats = { issued: certStatsRows?.cnt ?? 0 };

  const ts = now();
  const expiringSoon = await c.env.DB.prepare(
    `SELECT sc.id, sc.common_name, sc.expires_at, d.domain_name FROM ssl_certs sc
     JOIN domains d ON d.id = sc.domain_id
     WHERE sc.status = 'issued' AND sc.expires_at < ? AND (${domainScope})
     ORDER BY sc.expires_at ASC LIMIT 10`
  )
    .bind(ts + 20 * 24 * 3600)
    .all();

  const domainsExpiringSoon = await c.env.DB.prepare(
    `SELECT d.id, d.domain_name, d.whois_expires_at FROM domains d
     WHERE d.whois_expires_at IS NOT NULL AND d.whois_expires_at < ? AND (${domainScope})
     ORDER BY d.whois_expires_at ASC LIMIT 10`
  )
    .bind(ts + 20 * 24 * 3600)
    .all();

  const userCountRow = isAdmin
    ? await c.env.DB.prepare("SELECT COUNT(*) as cnt FROM users").first<{ cnt: number }>()
    : { cnt: null };

  const recentActivity = isAdmin
    ? (
        await c.env.DB.prepare(
          `SELECT al.action, al.target, al.detail, al.created_at, u.username
           FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id
           ORDER BY al.id DESC LIMIT 10`
        ).all()
      ).results
    : [];

  return c.json({
    domainCount: domainCountRow?.cnt ?? 0,
    providerCount: providerCountRow?.cnt ?? null,
    userCount: userCountRow?.cnt ?? null,
    certStats,
    expiringSoon: expiringSoon.results,
    domainsExpiringSoon: domainsExpiringSoon.results,
    recentActivity,
  });
});
