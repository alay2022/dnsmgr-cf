import { Hono } from "hono";
import type { Env, JwtPayload } from "../types";
import { requireAuth } from "../middleware/auth";
import { listDomainsForUser } from "../db";

export const domainRoutes = new Hono<{ Bindings: Env }>();
domainRoutes.use("*", requireAuth);

/** 返回当前登录用户有权限查看的域名列表（管理员看全部） */
domainRoutes.get("/", async (c) => {
  const user = c.get("user") as JwtPayload;
  // 若是「登录直达链接」签发的受限token，只返回锁定的那一个域名
  if (user.scopeDomainId) {
    const row = await c.env.DB.prepare(
      `SELECT d.*, p.type as provider_type, p.name as provider_name FROM domains d
       JOIN dns_providers p ON d.provider_id = p.id WHERE d.id = ?`
    )
      .bind(user.scopeDomainId)
      .first();
    return c.json(row ? [row] : []);
  }
  const domains = await listDomainsForUser(c.env, user.uid, user.role);
  return c.json(domains);
});
