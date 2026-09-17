import type { Env } from "../types";
import { now } from "../db";
import { notifyDomainOwners } from "../notify/domainOwners";

/** 提前几天提醒（精确匹配剩余天数，避免同一个阈值重复发送） */
const REMINDER_DAYS = [20, 10, 5, 4, 3, 2, 1];

/**
 * 每天 00:00 UTC（北京时间 08:00）由 Cloudflare Cron Trigger 调用一次。
 * 这个任务很轻量（只是查数据库+发通知，没有ACME签名运算），放在 Workers 里跑没有CPU限制问题，
 * 不需要像证书签发那样搬到 GitHub Actions。
 */
export async function handleExpiryReminders(env: Env) {
  const ts = now();
  const daysToRange = (days: number) => ({ start: ts + (days - 1) * 86400, end: ts + days * 86400 });

  for (const days of REMINDER_DAYS) {
    const { start, end } = daysToRange(days);

    // 域名注册到期提醒
    const { results: domains } = await env.DB.prepare(
      `SELECT id, domain_name, whois_expires_at FROM domains WHERE whois_expires_at >= ? AND whois_expires_at < ?`
    )
      .bind(start, end)
      .all<{ id: number; domain_name: string; whois_expires_at: number }>();

    for (const d of domains) {
      await notifyDomainOwners(env, d.id, {
        title: `域名到期提醒：还剩${days}天`,
        content: `域名 ${d.domain_name} 将在 ${days} 天后（${new Date(d.whois_expires_at * 1000).toLocaleDateString()}）到期，请及时续费，避免域名被释放。`,
      });
    }

    // SSL证书到期提醒（正常情况下20天内会被GitHub Actions自动续签，这里作为兜底提醒，
    // 万一自动续签失败或关闭了自动续签，也能及时知道）
    const { results: certs } = await env.DB.prepare(
      `SELECT sc.id, sc.common_name, sc.expires_at, sc.domain_id, sc.auto_renew FROM ssl_certs sc
       WHERE sc.status = 'issued' AND sc.expires_at >= ? AND sc.expires_at < ?`
    )
      .bind(start, end)
      .all<{ id: number; common_name: string; expires_at: number; domain_id: number; auto_renew: number }>();

    for (const cert of certs) {
      await notifyDomainOwners(env, cert.domain_id, {
        title: `SSL证书到期提醒：还剩${days}天`,
        content: `证书 ${cert.common_name} 将在 ${days} 天后（${new Date(cert.expires_at * 1000).toLocaleDateString()}）到期。${
          cert.auto_renew ? "已开启自动续签，正常情况下会在到期前自动处理，这条提醒是兜底通知。" : "该证书未开启自动续签，请手动续签。"
        }`,
      });
    }
  }
}
