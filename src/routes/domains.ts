import { Hono } from "hono";
import type { Env, JwtPayload } from "../types";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { listDomainsForUser, reorderDomains, batchDeleteDomains, insertAuditLog } from "../db";

export const domainRoutes = new Hono<{ Bindings: Env }>();
domainRoutes.use("*", requireAuth);

/** 返回当前登录用户有权限查看的域名列表（管理员看全部），按自定义排序返回 */
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

/** 拖拽排序后保存新顺序：body: { orderedIds: number[] } */
domainRoutes.put("/reorder", requireAdmin, async (c) => {
  const { orderedIds } = await c.req.json<{ orderedIds: number[] }>();
  if (!Array.isArray(orderedIds) || !orderedIds.length) return c.json({ error: "参数不能为空" }, 400);
  await reorderDomains(c.env, orderedIds);
  return c.json({ ok: true });
});

/** 批量删除域名：body: { domainIds: number[] } */
domainRoutes.post("/batch-delete", requireAdmin, async (c) => {
  const user = c.get("user") as JwtPayload;
  const { domainIds } = await c.req.json<{ domainIds: number[] }>();
  if (!Array.isArray(domainIds) || !domainIds.length) return c.json({ error: "参数不能为空" }, 400);
  await batchDeleteDomains(c.env, domainIds);
  await insertAuditLog(c.env, user.uid, "batch_delete_domains", domainIds.join(","));
  return c.json({ ok: true, deleted: domainIds.length });
});

/** 当前用户收藏的域名列表，供左侧栏快捷访问 */
domainRoutes.get("/favorites", async (c) => {
  const user = c.get("user") as JwtPayload;
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.domain_name FROM user_favorites uf
     JOIN domains d ON d.id = uf.domain_id
     WHERE uf.user_id = ? ORDER BY uf.created_at DESC`
  )
    .bind(user.uid)
    .all();
  return c.json(results);
});

/** 收藏/取消收藏某个域名：body: { favorite: boolean } */
domainRoutes.put("/:id/favorite", async (c) => {
  const user = c.get("user") as JwtPayload;
  const domainId = Number(c.req.param("id"));
  const { favorite } = await c.req.json<{ favorite: boolean }>();
  if (favorite) {
    await c.env.DB.prepare(
      "INSERT INTO user_favorites (user_id, domain_id, created_at) VALUES (?,?,?) ON CONFLICT(user_id, domain_id) DO NOTHING"
    )
      .bind(user.uid, domainId, Math.floor(Date.now() / 1000))
      .run();
  } else {
    await c.env.DB.prepare("DELETE FROM user_favorites WHERE user_id = ? AND domain_id = ?").bind(user.uid, domainId).run();
  }
  return c.json({ ok: true });
});
