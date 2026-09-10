import { Hono } from "hono";
import type { Env, JwtPayload } from "../types";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { hashPassword, verifyPassword, signJwt, randomToken } from "../utils/crypto";
import { userHasDomainPerm, now, insertAuditLog } from "../db";

export const applinkRoutes = new Hono<{ Bindings: Env }>();

// ---------------- 管理员：API Key 管理 ----------------
applinkRoutes.get("/keys", requireAuth, requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, user_id, key, remark, status, created_at FROM api_keys ORDER BY id"
  ).all();
  return c.json(results);
});

applinkRoutes.post("/keys", requireAuth, requireAdmin, async (c) => {
  const admin = c.get("user") as JwtPayload;
  const { userId, remark } = await c.req.json<{ userId: number; remark?: string }>();
  const apiKey = randomToken(16);
  const apiSecret = randomToken(24);
  const secretHash = await hashPassword(apiSecret);
  await c.env.DB.prepare(
    "INSERT INTO api_keys (user_id, key, secret_hash, remark, status, created_at) VALUES (?,?,?,?,?,?)"
  )
    .bind(userId ?? admin.uid, apiKey, secretHash, remark ?? null, "active", now())
    .run();
  // apiSecret 仅在创建时明文返回一次，请妥善保存
  return c.json({ apiKey, apiSecret });
});

applinkRoutes.delete("/keys/:id", requireAuth, requireAdmin, async (c) => {
  await c.env.DB.prepare("UPDATE api_keys SET status = 'revoked' WHERE id = ?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

// ---------------- 开放接口：供 IDC 系统获取「域名登录直达链接」 ----------------
/**
 * POST /api/open/applink
 * body: { apiKey, apiSecret, domainId, redirectBase? }
 * 返回一个短时有效（默认5分钟，见 APPLINK_EXPIRE_SECONDS）的一次性登录链接，
 * IDC 系统跳转过去即完成登录，且该登录态被锁定到 domainId 对应的域名，无法越权访问其他域名。
 */
applinkRoutes.post("/applink", async (c) => {
  const { apiKey, apiSecret, domainId, redirectBase } = await c.req.json<{
    apiKey: string;
    apiSecret: string;
    domainId: number;
    redirectBase?: string;
  }>();
  if (!apiKey || !apiSecret || !domainId) return c.json({ error: "参数不完整" }, 400);

  const keyRow = await c.env.DB.prepare("SELECT * FROM api_keys WHERE key = ? AND status = 'active'").bind(apiKey).first();
  if (!keyRow) return c.json({ error: "无效的API Key" }, 401);

  const ok = await verifyPassword(apiSecret, (keyRow as any).secret_hash);
  if (!ok) return c.json({ error: "API Secret 不正确" }, 401);

  const userId = (keyRow as any).user_id as number;
  const userRow = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
  if (!userRow || (userRow as any).status !== "active") return c.json({ error: "关联用户不可用" }, 403);

  if ((userRow as any).role !== "admin") {
    const hasPerm = await userHasDomainPerm(c.env, userId, domainId, false);
    if (!hasPerm) return c.json({ error: "该用户无权限访问此域名" }, 403);
  }

  const expireSeconds = Number(c.env.APPLINK_EXPIRE_SECONDS || 300);
  const payload: JwtPayload = {
    uid: userId,
    username: (userRow as any).username,
    role: (userRow as any).role,
    scopeDomainId: domainId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expireSeconds,
  };
  const token = await signJwt(payload, c.env.JWT_SECRET);

  const base = redirectBase || new URL(c.req.url).origin;
  const loginUrl = `${base}/direct-login?token=${token}&domainId=${domainId}`;

  await insertAuditLog(c.env, userId, "issue_applink", `domain:${domainId}`, undefined, c.req.header("cf-connecting-ip") ?? undefined);

  return c.json({ url: loginUrl, token, expiresIn: expireSeconds });
});
