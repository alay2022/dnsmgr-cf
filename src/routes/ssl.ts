import { Hono } from "hono";
import type { Env, JwtPayload } from "../types";
import { requireAuth, requireDomainPerm } from "../middleware/auth";
import { getDomainById, now, insertAuditLog } from "../db";
import { createProviderInstance } from "../providers/registry";
import { AcmeClient } from "../acme/client";

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
 * 自动通过对应域名的 DNS Provider 完成 DNS-01 验证并写回证书。
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
    const dnsProvider = await createProviderInstance(c.env, domain.provider_type, domain.provider_credentials);
    const acme = await AcmeClient.create(c.env.ACME_ACCOUNT_EMAIL);
    await acme.ensureAccount();

    const result = await acme.issueCertificate({
      commonName,
      sans: sans || [],
      dnsProvider,
      rootDomain: domain.domain_name,
    });

    await c.env.DB.prepare(
      `UPDATE ssl_certs SET status='issued', cert_pem=?, key_pem=?, issued_at=?, expires_at=?, updated_at=? WHERE id=?`
    )
      .bind(result.certPem, result.keyPem, now(), result.expiresAt, now(), certId)
      .run();

    await insertAuditLog(c.env, user.uid, "issue_cert", `${domain.domain_name}(${commonName})`);
    return c.json({ ok: true, certId });
  } catch (e: any) {
    await c.env.DB.prepare("UPDATE ssl_certs SET status='failed', updated_at=? WHERE id=?").bind(now(), certId).run();
    return c.json({ ok: false, error: e.message }, 500);
  }
});

sslRoutes.get("/:domainId/certs/:certId/download", requireDomainPerm(false), async (c) => {
  const certId = Number(c.req.param("certId"));
  const row = await c.env.DB.prepare("SELECT * FROM ssl_certs WHERE id = ?").bind(certId).first<any>();
  if (!row || row.status !== "issued") return c.json({ error: "证书不存在或尚未签发成功" }, 404);
  return c.json({ certPem: row.cert_pem, keyPem: row.key_pem, expiresAt: row.expires_at });
});

sslRoutes.post("/:domainId/certs/:certId/renew", requireDomainPerm(true), async (c) => {
  const user = c.get("user") as JwtPayload;
  const domainId = Number(c.req.param("domainId"));
  const certId = Number(c.req.param("certId"));
  const domain = (await getDomainById(c.env, domainId)) as any;
  const cert = await c.env.DB.prepare("SELECT * FROM ssl_certs WHERE id = ?").bind(certId).first<any>();
  if (!domain || !cert) return c.json({ error: "记录不存在" }, 404);

  try {
    const dnsProvider = await createProviderInstance(c.env, domain.provider_type, domain.provider_credentials);
    const acme = await AcmeClient.create(c.env.ACME_ACCOUNT_EMAIL);
    await acme.ensureAccount();
    const result = await acme.issueCertificate({
      commonName: cert.common_name,
      sans: JSON.parse(cert.sans || "[]"),
      dnsProvider,
      rootDomain: domain.domain_name,
    });
    await c.env.DB.prepare(
      `UPDATE ssl_certs SET status='issued', cert_pem=?, key_pem=?, issued_at=?, expires_at=?, updated_at=? WHERE id=?`
    )
      .bind(result.certPem, result.keyPem, now(), result.expiresAt, now(), certId)
      .run();
    await insertAuditLog(c.env, user.uid, "renew_cert", `${domain.domain_name}(${cert.common_name})`);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});
