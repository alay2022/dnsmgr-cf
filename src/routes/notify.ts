import { Hono } from "hono";
import type { Env, JwtPayload } from "../types";
import { requireAuth } from "../middleware/auth";
import { now } from "../db";
import { sendNotify, type NotifyChannelType } from "../notify/channels";

export const notifyRoutes = new Hono<{ Bindings: Env }>();
notifyRoutes.use("*", requireAuth);

notifyRoutes.get("/", async (c) => {
  const user = c.get("user") as JwtPayload;
  const { results } = await c.env.DB.prepare(
    "SELECT id, type, enabled, created_at FROM notify_channels WHERE user_id = ? ORDER BY id"
  )
    .bind(user.uid)
    .all();
  return c.json(results);
});

notifyRoutes.post("/", async (c) => {
  const user = c.get("user") as JwtPayload;
  const { type, config } = await c.req.json<{ type: NotifyChannelType; config: Record<string, any> }>();
  await c.env.DB.prepare("INSERT INTO notify_channels (user_id, type, config, enabled, created_at) VALUES (?,?,?,?,?)")
    .bind(user.uid, type, JSON.stringify(config), 1, now())
    .run();
  return c.json({ ok: true });
});

notifyRoutes.get("/:id", async (c) => {
  const user = c.get("user") as JwtPayload;
  const row = await c.env.DB.prepare("SELECT * FROM notify_channels WHERE id = ? AND user_id = ?")
    .bind(Number(c.req.param("id")), user.uid)
    .first<any>();
  if (!row) return c.json({ error: "渠道不存在" }, 404);
  return c.json({ id: row.id, type: row.type, config: JSON.parse(row.config), enabled: row.enabled });
});

notifyRoutes.put("/:id", async (c) => {
  const user = c.get("user") as JwtPayload;
  const { config } = await c.req.json<{ config: Record<string, any> }>();
  await c.env.DB.prepare("UPDATE notify_channels SET config = ? WHERE id = ? AND user_id = ?")
    .bind(JSON.stringify(config), Number(c.req.param("id")), user.uid)
    .run();
  return c.json({ ok: true });
});

notifyRoutes.delete("/:id", async (c) => {
  const user = c.get("user") as JwtPayload;
  await c.env.DB.prepare("DELETE FROM notify_channels WHERE id = ? AND user_id = ?")
    .bind(Number(c.req.param("id")), user.uid)
    .run();
  return c.json({ ok: true });
});

notifyRoutes.post("/:id/test", async (c) => {
  const user = c.get("user") as JwtPayload;
  const row = await c.env.DB.prepare("SELECT * FROM notify_channels WHERE id = ? AND user_id = ?")
    .bind(Number(c.req.param("id")), user.uid)
    .first<any>();
  if (!row) return c.json({ error: "渠道不存在" }, 404);
  try {
    await sendNotify(row.type, JSON.parse(row.config), {
      title: "DNSMGR-CF 测试通知",
      content: "这是一条测试消息，如果你收到了，说明该通知渠道配置成功。",
    });
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 200);
  }
});
