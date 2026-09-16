import { Hono } from "hono";
import type { Env } from "../types";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { listUsers, createUser, grantDomainPerm, revokeDomainPerm } from "../db";
import { hashPassword } from "../utils/crypto";

export const userRoutes = new Hono<{ Bindings: Env }>();
userRoutes.use("*", requireAuth, requireAdmin);

userRoutes.get("/", async (c) => c.json(await listUsers(c.env)));

userRoutes.post("/", async (c) => {
  const { username, password, role, email } = await c.req.json<{
    username: string;
    password: string;
    role?: "admin" | "user";
    email?: string;
  }>();
  if (!username || !password) return c.json({ error: "用户名和密码必填" }, 400);
  const hash = await hashPassword(password);
  await createUser(c.env, username, hash, role || "user", email);
  return c.json({ ok: true });
});

userRoutes.put("/:id/status", async (c) => {
  const id = Number(c.req.param("id"));
  const { status } = await c.req.json<{ status: "active" | "disabled" }>();
  await c.env.DB.prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ?")
    .bind(status, Math.floor(Date.now() / 1000), id)
    .run();
  return c.json({ ok: true });
});

/** 管理员直接重置某用户的密码（不需要旧密码，区别于用户自己修改密码的 /auth/change-password） */
userRoutes.put("/:id/password", async (c) => {
  const id = Number(c.req.param("id"));
  const { newPassword } = await c.req.json<{ newPassword: string }>();
  if (!newPassword || newPassword.length < 6) return c.json({ error: "新密码长度至少6位" }, 400);
  const hash = await hashPassword(newPassword);
  await c.env.DB.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
    .bind(hash, Math.floor(Date.now() / 1000), id)
    .run();
  return c.json({ ok: true });
});

/** 删除用户，同时清理其域名权限、API Key、通知渠道配置；不允许删除内置admin或删除自己 */
userRoutes.delete("/:id", async (c) => {
  const admin = c.get("user") as import("../types").JwtPayload;
  const id = Number(c.req.param("id"));
  if (id === admin.uid) return c.json({ error: "不能删除自己" }, 400);

  const target = await c.env.DB.prepare("SELECT username FROM users WHERE id = ?").bind(id).first<{ username: string }>();
  if (!target) return c.json({ error: "用户不存在" }, 404);
  if (target.username === "admin") return c.json({ error: "不能删除内置管理员账号" }, 400);

  await c.env.DB.prepare("DELETE FROM user_domain_perms WHERE user_id = ?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM api_keys WHERE user_id = ?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM notify_channels WHERE user_id = ?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

/** 为用户授予某个域名的权限（readonly | readwrite） */
userRoutes.post("/:id/domain-perms", async (c) => {
  const userId = Number(c.req.param("id"));
  const { domainId, perm } = await c.req.json<{ domainId: number; perm: "readonly" | "readwrite" }>();
  await grantDomainPerm(c.env, userId, domainId, perm);
  return c.json({ ok: true });
});

userRoutes.delete("/:id/domain-perms/:domainId", async (c) => {
  const userId = Number(c.req.param("id"));
  const domainId = Number(c.req.param("domainId"));
  await revokeDomainPerm(c.env, userId, domainId);
  return c.json({ ok: true });
});

userRoutes.get("/:id/domain-perms", async (c) => {
  const userId = Number(c.req.param("id"));
  const { results } = await c.env.DB.prepare(
    `SELECT up.domain_id, up.perm, d.domain_name FROM user_domain_perms up
     JOIN domains d ON d.id = up.domain_id WHERE up.user_id = ?`
  )
    .bind(userId)
    .all();
  return c.json(results);
});
