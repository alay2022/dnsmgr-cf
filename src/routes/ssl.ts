import { Hono } from "hono";
import type { Env, JwtPayload } from "../types";
import { requireAuth, requireDomainPerm } from "../middleware/auth";
import { getDomainById, now, insertAuditLog } from "../db";
import { triggerGithubWorkflow } from "../github";

export const sslRoutes = new Hono<{ Bindings: Env }>();
sslRoutes.use("*", requireAuth);

sslRoutes.get("/:domainId/certs", requireDomainPerm(false), async (c) => {
  const domainId = Number(c.req.param("domainId"));
  const { results } = await c.env.DB.prepare("SELECT * FROM ssl_certs WHERE domain_id = ? ORDER BY id DESC")
    .bind(domainId)
    .all();
  return c.json(results);
});

/**
 * 申请证书：body: { commonName, sans?: string[], autoRenew?: boolean }
 * 实际签发工作已经搬到 GitHub Actions 里跑（避开 Cloudflare Workers Free 计划10ms CPU时间限制），
 * 这里只负责：插入一条 pending 记录，然后触发 GitHub 的 issue-cert.yml workflow。
 * 前端轮询 GET /:domainId/certs 来获取最终状态（GitHub Actions 跑完后会回调 /api/ci/certs/:id/complete）。
 */
sslRoutes.post("/:domainId/certs", requireDomainPerm(true), async (c) => {
  const user = c.get("user") as JwtPayload;
  const domainId = Number(c.req.param("domainId"));
  const { commonName, sans, autoRenew } = await c.req.json<{ commonName: string; sans?: string[]; autoRenew?: boolean }>();

  const domain = (await getDomainById(c.env, domainId)) as any;
  if (!domain) return c.json({ error: "域名不存在" }, 404);

  const ts = now();
  const insertRes = await c.env.DB.prepare(
    `INSERT INTO ssl_certs (domain_id, common_name, sans, ca, status, auto_renew, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`
  )
    .bind(domainId, commonName, JSON.stringify(sans || []), "letsencrypt", "pending", autoRenew === false ? 0 : 1, ts, ts)
    .run();
  const certId = insertRes.meta.last_row_id;

  try {
    await triggerGithubWorkflow(c.env, "issue-cert.yml", {
      domain_id: String(domainId),
      cert_id: String(certId),
      common_name: commonName,
      sans: (sans || []).join(","),
      root_domain: domain.domain_name,
    });
    await insertAuditLog(c.env, user.uid, "trigger_issue_cert", `${domain.domain_name}(${commonName})`);
  } catch (e: any) {
    await c.env.DB.prepare("UPDATE ssl_certs SET status='failed', updated_at=? WHERE id=?").bind(now(), certId).run();
    return c.json({ ok: false, error: e.message }, 500);
  }

  return c.json({ ok: true, certId, status: "pending" });
});

sslRoutes.get("/:domainId/certs/:certId/download", requireDomainPerm(false), async (c) => {
  const certId = Number(c.req.param("certId"));
  const row = await c.env.DB.prepare("SELECT * FROM ssl_certs WHERE id = ?").bind(certId).first<any>();
  if (!row || row.status !== "issued") return c.json({ error: "证书不存在或尚未签发成功" }, 404);
  return c.json({ certPem: row.cert_pem, keyPem: row.key_pem, expiresAt: row.expires_at });
});

/** 续签同样只负责把状态置回 pending 并触发 workflow，实际工作交给 GitHub Actions */
sslRoutes.post("/:domainId/certs/:certId/renew", requireDomainPerm(true), async (c) => {
  const user = c.get("user") as JwtPayload;
  const domainId = Number(c.req.param("domainId"));
  const certId = Number(c.req.param("certId"));
  const domain = (await getDomainById(c.env, domainId)) as any;
  const cert = await c.env.DB.prepare("SELECT * FROM ssl_certs WHERE id = ?").bind(certId).first<any>();
  if (!domain || !cert) return c.json({ error: "记录不存在" }, 404);

  await c.env.DB.prepare("UPDATE ssl_certs SET status='pending', updated_at=? WHERE id=?").bind(now(), certId).run();

  try {
    await triggerGithubWorkflow(c.env, "issue-cert.yml", {
      domain_id: String(domainId),
      cert_id: String(certId),
      common_name: cert.common_name,
      sans: JSON.parse(cert.sans || "[]").join(","),
      root_domain: domain.domain_name,
    });
    await insertAuditLog(c.env, user.uid, "trigger_renew_cert", `${domain.domain_name}(${cert.common_name})`);
  } catch (e: any) {
    await c.env.DB.prepare("UPDATE ssl_certs SET status='failed', updated_at=? WHERE id=?").bind(now(), certId).run();
    return c.json({ ok: false, error: e.message }, 500);
  }

  return c.json({ ok: true, status: "pending" });
});
