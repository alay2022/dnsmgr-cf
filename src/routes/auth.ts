import { Hono } from "hono";
import type { Env, JwtPayload } from "../types";
import { getUserByUsername, getUserById, insertAuditLog } from "../db";
import { hashPassword, verifyPassword, signJwt } from "../utils/crypto";
import { requireAuth } from "../middleware/auth";

export const authRoutes = new Hono<{ Bindings: Env }>();

authRoutes.post("/login", async (c) => {
  const { username, password } = await c.req.json<{ username: string; password: string }>();
  if (!username || !password) return c.json({ error: "请输入用户名和密码" }, 400);

  const user = await getUserByUsername(c.env, username);
  if (!user) return c.json({ error: "用户名或密码错误" }, 401);
  if ((user as any).status !== "active") return c.json({ error: "账号已被禁用，请联系管理员" }, 403);

  const ok = await verifyPassword(password, (user as any).password_hash);
  if (!ok) return c.json({ error: "用户名或密码错误" }, 401);

  const expireSeconds = Number(c.env.JWT_EXPIRE_SECONDS || 86400);
  const payload: JwtPayload = {
    uid: (user as any).id,
    username: (user as any).username,
    role: (user as any).role,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expireSeconds,
  };
  const token = await signJwt(payload, c.env.JWT_SECRET);
  await insertAuditLog(c.env, payload.uid, "login", undefined, undefined, c.req.header("cf-connecting-ip") ?? undefined);

  return c.json({
    token,
    user: { id: payload.uid, username: payload.username, role: payload.role },
    forcePasswordChange: (user as any).username === "admin" && (await verifyPassword("admin", (user as any).password_hash)),
  });
});

authRoutes.post("/change-password", requireAuth, async (c) => {
  const user = c.get("user") as JwtPayload;
  const { oldPassword, newPassword } = await c.req.json<{ oldPassword: string; newPassword: string }>();
  if (!newPassword || newPassword.length < 6) return c.json({ error: "新密码长度至少6位" }, 400);

  const dbUser = await getUserById(c.env, user.uid);
  if (!dbUser) return c.json({ error: "用户不存在" }, 404);

  const ok = await verifyPassword(oldPassword, (dbUser as any).password_hash);
  if (!ok) return c.json({ error: "原密码不正确" }, 401);

  const newHash = await hashPassword(newPassword);
  await c.env.DB.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
    .bind(newHash, Math.floor(Date.now() / 1000), user.uid)
    .run();

  return c.json({ ok: true });
});

authRoutes.get("/me", requireAuth, async (c) => {
  const user = c.get("user") as JwtPayload;
  return c.json({ id: user.uid, username: user.username, role: user.role });
});
