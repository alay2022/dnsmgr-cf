import type { Env } from "../types";
import { sendNotify } from "./channels";

/** 向该域名有权限的用户 + 所有管理员配置的通知渠道推送消息 */
export async function notifyDomainOwners(env: Env, domainId: number, msg: { title: string; content: string }) {
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
