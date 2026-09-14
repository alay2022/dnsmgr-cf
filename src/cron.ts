import type { Env } from "./types";
import { getDomainById, now } from "./db";
import { createProviderInstance } from "./providers/registry";
import { AcmeClient } from "./acme/client";
import { sendNotify } from "./notify/channels";

/** 每天由 wrangler.toml 中配置的 Cron Trigger 调用一次 */
export async function handleScheduled(env: Env) {
  const ts = now();
  const RENEW_WINDOW_SECONDS = 20 * 24 * 3600; // 到期前20天开始自动续签（Let's Encrypt 建议）

  const { results: certs } = await env.DB.prepare(
    "SELECT * FROM ssl_certs WHERE status = 'issued' AND auto_renew = 1 AND expires_at < ?"
  )
    .bind(ts + RENEW_WINDOW_SECONDS)
    .all();

  for (const cert of certs as any[]) {
    const domain = (await getDomainById(env, cert.domain_id)) as any;
    if (!domain) continue;

    try {
      const dnsProvider = await createProviderInstance(env, domain.provider_type, domain.provider_credentials);
      const acme = await AcmeClient.create(env.ACME_ACCOUNT_EMAIL, undefined, env.ACME_DIRECTORY_URL);
      await acme.ensureAccount(env.ACME_EAB_KID && env.ACME_EAB_HMAC_KEY ? { kid: env.ACME_EAB_KID, hmacKey: env.ACME_EAB_HMAC_KEY } : undefined);
      const result = await acme.issueCertificate({
        commonName: cert.common_name,
        sans: JSON.parse(cert.sans || "[]"),
        dnsProvider,
        rootDomain: domain.domain_name,
      });
      await env.DB.prepare(
        `UPDATE ssl_certs SET cert_pem=?, key_pem=?, issued_at=?, expires_at=?, updated_at=? WHERE id=?`
      )
        .bind(result.certPem, result.keyPem, ts, result.expiresAt, ts, cert.id)
        .run();

      await notifyDomainOwners(env, domain.id, {
        title: "证书自动续签成功",
        content: `域名 ${cert.common_name} 的证书已自动续签，新的有效期至 ${new Date(result.expiresAt * 1000).toLocaleDateString()}。`,
      });
    } catch (e: any) {
      await env.DB.prepare("UPDATE ssl_certs SET status='failed', updated_at=? WHERE id=?").bind(ts, cert.id).run();
      await notifyDomainOwners(env, domain.id, {
        title: "证书自动续签失败",
        content: `域名 ${cert.common_name} 自动续签失败：${e.message}，请登录系统手动处理。`,
      });
    }
  }
}

async function notifyDomainOwners(env: Env, domainId: number, msg: { title: string; content: string }) {
  const { results: channels } = await env.DB.prepare(
    `SELECT DISTINCT nc.* FROM notify_channels nc
     WHERE nc.enabled = 1 AND (
       nc.user_id IN (SELECT user_id FROM user_domain_perms WHERE domain_id = ?)
       OR nc.user_id IN (SELECT id FROM users WHERE role = 'admin')
     )`
  )
    .bind(domainId)
    .all();

  for (const ch of channels as any[]) {
    try {
      await sendNotify(ch.type, JSON.parse(ch.config), msg);
    } catch {
      /* 单个渠道发送失败不影响其他渠道 */
    }
  }
}
