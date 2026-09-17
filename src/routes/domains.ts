import { Hono } from "hono";
import type { Env, JwtPayload } from "../types";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { listDomainsForUser, reorderDomains, batchDeleteDomains, insertAuditLog, now, userHasDomainPerm } from "../db";
import { lookupWhois } from "../utils/whois";

export const domainRoutes = new Hono<{ Bindings: Env }>();
domainRoutes.use("*", requireAuth);

/** 返回当前登录用户有权限查看的域名列表（管理员看全部），按自定义排序返回；可选 ?providerId= 按解析平台账号筛选 */
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
  const providerId = c.req.query("providerId");
  let domains = await listDomainsForUser(c.env, user.uid, user.role);
  if (providerId) domains = (domains as any[]).filter((d) => String(d.provider_id) === providerId);
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

/** 查询/刷新某个域名的注册到期时间（whois/RDAP），结果缓存在数据库，不是每次打开页面都查 */
domainRoutes.post("/:id/refresh-whois", async (c) => {
  const user = c.get("user") as JwtPayload;
  const domainId = Number(c.req.param("id"));

  if (user.role !== "admin") {
    const ok = await userHasDomainPerm(c.env, user.uid, domainId, false);
    if (!ok) return c.json({ error: "无权限" }, 403);
  }

  const domain = await c.env.DB.prepare("SELECT domain_name FROM domains WHERE id = ?").bind(domainId).first<{ domain_name: string }>();
  if (!domain) return c.json({ error: "域名不存在" }, 404);

  try {
    const whois = await lookupWhois(domain.domain_name);
    const ts = now();
    let expiresAtSeconds: number | null = null;
    if (whois.expiresAt) {
      const parsed = Date.parse(whois.expiresAt);
      if (!isNaN(parsed)) expiresAtSeconds = Math.floor(parsed / 1000);
    }
    await c.env.DB.prepare("UPDATE domains SET whois_expires_at = ?, whois_checked_at = ? WHERE id = ?")
      .bind(expiresAtSeconds, ts, domainId)
      .run();
    return c.json({ ok: true, whoisExpiresAt: expiresAtSeconds });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 200);
  }
});
