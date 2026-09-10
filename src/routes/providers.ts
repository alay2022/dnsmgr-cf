import { Hono } from "hono";
import type { Env, JwtPayload } from "../types";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { aesEncrypt } from "../utils/crypto";
import { SUPPORTED_PROVIDER_TYPES, createProviderInstance } from "../providers/registry";
import { now } from "../db";

export const providerRoutes = new Hono<{ Bindings: Env }>();
providerRoutes.use("*", requireAuth, requireAdmin);

providerRoutes.get("/types", (c) => c.json(SUPPORTED_PROVIDER_TYPES));

providerRoutes.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, type, owner_user_id, created_at FROM dns_providers ORDER BY id"
  ).all();
  return c.json(results);
});

/** 新增解析平台账号；credentials 明文JSON在这里加密后落库，之后永不明文返回 */
providerRoutes.post("/", async (c) => {
  const user = c.get("user") as JwtPayload;
  const { name, type, credentials } = await c.req.json<{ name: string; type: string; credentials: Record<string, string> }>();
  if (!SUPPORTED_PROVIDER_TYPES.includes(type as any)) return c.json({ error: "不支持的平台类型" }, 400);

  const plainJson = JSON.stringify(credentials);
  const encrypted = c.env.ENCRYPT_KEY ? await aesEncrypt(plainJson, c.env.ENCRYPT_KEY) : plainJson;

  const ts = now();
  const res = await c.env.DB.prepare(
    "INSERT INTO dns_providers (name, type, credentials, owner_user_id, created_at, updated_at) VALUES (?,?,?,?,?,?)"
  )
    .bind(name, type, encrypted, user.uid, ts, ts)
    .run();

  return c.json({ ok: true, id: res.meta.last_row_id });
});

providerRoutes.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM dns_providers WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

/** 测试凭据是否有效：尝试调用 listDomains */
providerRoutes.post("/:id/test", async (c) => {
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare("SELECT * FROM dns_providers WHERE id = ?").bind(id).first();
  if (!row) return c.json({ error: "账号不存在" }, 404);
  try {
    const instance = await createProviderInstance(c.env, (row as any).type, (row as any).credentials);
    const domains = await instance.listDomains();
    return c.json({ ok: true, domainCount: domains.length });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 200);
  }
});

/** 从平台侧同步域名列表到本地 domains 表 */
providerRoutes.post("/:id/sync-domains", async (c) => {
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare("SELECT * FROM dns_providers WHERE id = ?").bind(id).first();
  if (!row) return c.json({ error: "账号不存在" }, 404);

  const instance = await createProviderInstance(c.env, (row as any).type, (row as any).credentials);
  const domains = await instance.listDomains();
  const ts = now();
  for (const d of domains) {
    await c.env.DB.prepare(
      `INSERT INTO domains (provider_id, domain_name, status, synced_at, created_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(provider_id, domain_name) DO UPDATE SET status = excluded.status, synced_at = excluded.synced_at`
    )
      .bind(id, d.domainName, d.status || "active", ts, ts)
      .run();
  }
  return c.json({ ok: true, synced: domains.length });
});
