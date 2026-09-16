import { Hono } from "hono";
import type { Env, JwtPayload } from "../types";
import { requireAuth, requireDomainPerm } from "../middleware/auth";
import { getDomainById, now, insertAuditLog } from "../db";
import { triggerGithubWorkflow } from "../github";

export const sslRoutes = new Hono<{ Bindings: Env }>();
sslRoutes.use("*", requireAuth);

/**
 * 证书总览：GET /:domainId/certs 是某个域名的证书；GET /certs 是全部域名的证书（管理员看全部，
 * 普通用户只看自己有权限的域名），供证书列表页默认展示全部、也支持上方下拉框按域名筛选。
 */
sslRoutes.get("/certs", async (c) => {
  const user = c.get("user") as JwtPayload;
  const scope =
    user.role === "admin"
      ? "1=1"
      : `sc.domain_id IN (SELECT domain_id FROM user_domain_perms WHERE user_id = ${user.uid})`;
  const { results } = await c.env.DB.prepare(
    `SELECT sc.*, d.domain_name FROM ssl_certs sc
     JOIN domains d ON d.id = sc.domain_id
     WHERE ${scope}
     ORDER BY sc.id DESC`
  ).all();
  return c.json(results);
});

/** 批量删除证书记录：body: { certIds: number[] }（只删本地数据库记录，不会去CA吊销证书） */
sslRoutes.post("/certs/batch-delete", async (c) => {
  const user = c.get("user") as JwtPayload;
  const { certIds } = await c.req.json<{ certIds: number[] }>();
  if (!Array.isArray(certIds) || !certIds.length) return c.json({ error: "参数不能为空" }, 400);

  if (user.role !== "admin") {
    // 非管理员只能删除自己有权限的域名下的证书
    const { results } = await c.env.DB.prepare(
      `SELECT sc.id FROM ssl_certs sc
       WHERE sc.id IN (${certIds.map(() => "?").join(",")})
       AND sc.domain_id NOT IN (SELECT domain_id FROM user_domain_perms WHERE user_id = ? AND perm = 'readwrite')`
    )
      .bind(...certIds, user.uid)
      .all();
    if (results.length) return c.json({ error: "存在无权限删除的证书" }, 403);
  }

  await c.env.DB.batch(certIds.map((id) => c.env.DB.prepare("DELETE FROM ssl_certs WHERE id = ?").bind(id)));
  await insertAuditLog(c.env, user.uid, "batch_delete_certs", certIds.join(","));
  return c.json({ ok: true, deleted: certIds.length });
});

sslRoutes.get("/:domainId/certs", requireDomainPerm(false), async (c) => {
  const domainId = Number(c.req.param("domainId"));
  const { results } = await c.env.DB.prepare("SELECT * FROM ssl_certs WHERE domain_id = ? ORDER BY id DESC")
    .bind(domainId)
    .all();
  return c.json(results);
});

/**
 * 申请证书：body: { commonName, sans?: string[], autoRenew?: boolean }
 * commonName 留空或传 "@" 时，默认等同于域名本身（根域名）。
 * 实际签发工作已经搬到 GitHub Actions 里跑（避开 Cloudflare Workers Free 计划10ms CPU时间限制），
 * 这里只负责：插入一条 pending 记录，然后触发 GitHub 的 issue-cert.yml workflow。
 * 前端轮询 GET /:domainId/certs 来获取最终状态（GitHub Actions 跑完后会回调 /api/ci/certs/:id/complete）。
 */
sslRoutes.post("/:domainId/certs", requireDomainPerm(true), async (c) => {
  const user = c.get("user") as JwtPayload;
  const domainId = Number(c.req.param("domainId"));
  const body = await c.req.json<{ commonName?: string; sans?: string[]; autoRenew?: boolean }>();

  const domain = (await getDomainById(c.env, domainId)) as any;
  if (!domain) return c.json({ error: "域名不存在" }, 404);

  const commonName = !body.commonName || body.commonName.trim() === "@" ? domain.domain_name : body.commonName.trim();
  const sans = body.sans || [];

  const ts = now();
  const insertRes = await c.env.DB.prepare(
    `INSERT INTO ssl_certs (domain_id, common_name, sans, ca, status, auto_renew, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`
  )
    .bind(domainId, commonName, JSON.stringify(sans), "letsencrypt", "pending", body.autoRenew === false ? 0 : 1, ts, ts)
    .run();
  const certId = insertRes.meta.last_row_id;

  try {
    await triggerGithubWorkflow(c.env, "issue-cert.yml", {
      domain_id: String(domainId),
      cert_id: String(certId),
      common_name: commonName,
      sans: sans.join(","),
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
