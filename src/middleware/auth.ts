import type { Context, Next } from "hono";
import type { Env, JwtPayload } from "../types";
import { verifyJwt } from "../utils/crypto";
import { userHasDomainPerm } from "../db";

/** 校验 Bearer JWT，把用户信息挂到 c.set('user', ...) */
export async function requireAuth(c: Context<{ Bindings: Env }>, next: Next) {
  const authHeader = c.req.header("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return c.json({ error: "未登录" }, 401);

  const payload = await verifyJwt<JwtPayload>(token, c.env.JWT_SECRET);
  if (!payload) return c.json({ error: "登录已过期，请重新登录" }, 401);

  c.set("user", payload);
  await next();
}

/** 仅管理员可访问 */
export async function requireAdmin(c: Context<{ Bindings: Env }>, next: Next) {
  const user = c.get("user") as JwtPayload;
  if (user.role !== "admin") return c.json({ error: "仅管理员可操作" }, 403);
  await next();
}

/**
 * 校验当前用户对 :domainId 路径参数指向的域名是否有权限。
 * needWrite=true 时要求 readwrite 权限。
 */
export function requireDomainPerm(needWrite = false) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const user = c.get("user") as JwtPayload;
    const domainId = Number(c.req.param("domainId"));
    if (!domainId) return c.json({ error: "缺少 domainId" }, 400);

    // 若是通过「登录直达链接」签发的受限token，强制锁定到该域名
    if (user.scopeDomainId && user.scopeDomainId !== domainId) {
      return c.json({ error: "该登录链接无权访问此域名" }, 403);
    }

    if (user.role === "admin") return next();

    const ok = await userHasDomainPerm(c.env, user.uid, domainId, needWrite);
    if (!ok) return c.json({ error: "无权限访问该域名" }, 403);
    await next();
  };
}
