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

/**
 * 从平台侧拉取域名列表，仅用于展示供管理员勾选，不写入数据库。
 * 返回结果会标注 imported: 是否已经导入过。
 */
providerRoutes.post("/:id/discover-domains", async (c) => {
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare("SELECT * FROM dns_providers WHERE id = ?").bind(id).first();
  if (!row) return c.json({ error: "账号不存在" }, 404);

  const instance = await createProviderInstance(c.env, (row as any).type, (row as any).credentials);
  const domains = await instance.listDomains();

  const { results: imported } = await c.env.DB.prepare("SELECT domain_name FROM domains WHERE provider_id = ?")
    .bind(id)
    .all<{ domain_name: string }>();
  const importedSet = new Set(imported.map((r) => r.domain_name));

  return c.json(
    domains.map((d) => ({ domainName: d.domainName, status: d.status, imported: importedSet.has(d.domainName) }))
  );
});

/** 把勾选的域名导入到本地管理：body: { domainNames: string[] } */
providerRoutes.post("/:id/import-domains", async (c) => {
  const id = Number(c.req.param("id"));
  const { domainNames } = await c.req.json<{ domainNames: string[] }>();
  if (!Array.isArray(domainNames) || !domainNames.length) return c.json({ error: "请至少选择一个域名" }, 400);

  const row = await c.env.DB.prepare("SELECT * FROM dns_providers WHERE id = ?").bind(id).first();
  if (!row) return c.json({ error: "账号不存在" }, 404);

  // 导入的域名排在当前最大 sort_order 之后
  const maxRow = await c.env.DB.prepare("SELECT MAX(sort_order) as maxOrder FROM domains").first<{ maxOrder: number | null }>();
  let nextOrder = (maxRow?.maxOrder ?? 0) + 1;

  const ts = now();
  for (const domainName of domainNames) {
    await c.env.DB.prepare(
      `INSERT INTO domains (provider_id, domain_name, status, sort_order, synced_at, created_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(provider_id, domain_name) DO UPDATE SET status = excluded.status, synced_at = excluded.synced_at`
    )
      .bind(id, domainName, "active", nextOrder++, ts, ts)
      .run();
  }
  return c.json({ ok: true, imported: domainNames.length });
});
