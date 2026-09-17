import { Hono } from "hono";
import type { Env, JwtPayload } from "../types";
import { requireAuth } from "../middleware/auth";
import { aesEncrypt } from "../utils/crypto";
import { SUPPORTED_PROVIDER_TYPES, createProviderInstance } from "../providers/registry";
import { now, batchDeleteDomains, grantDomainPerm } from "../db";

export const providerRoutes = new Hono<{ Bindings: Env }>();
providerRoutes.use("*", requireAuth);

/** 管理员能操作所有账号；普通用户只能操作自己创建的账号 */
async function checkOwnership(c: any, providerId: number): Promise<{ ok: boolean; row?: any }> {
  const user = c.get("user") as JwtPayload;
  const row = await c.env.DB.prepare("SELECT * FROM dns_providers WHERE id = ?").bind(providerId).first();
  if (!row) return { ok: false };
  if (user.role === "admin") return { ok: true, row };
  return { ok: (row as any).owner_user_id === user.uid, row };
}

providerRoutes.get("/types", (c) => c.json(SUPPORTED_PROVIDER_TYPES));

/** 管理员看全部账号；普通用户只看自己创建的账号 */
providerRoutes.get("/", async (c) => {
  const user = c.get("user") as JwtPayload;
  const { results } =
    user.role === "admin"
      ? await c.env.DB.prepare("SELECT id, name, type, owner_user_id, created_at FROM dns_providers ORDER BY id").all()
      : await c.env.DB.prepare("SELECT id, name, type, owner_user_id, created_at FROM dns_providers WHERE owner_user_id = ? ORDER BY id")
          .bind(user.uid)
          .all();
  return c.json(results);
});

/** 新增解析平台账号（任何登录用户都能新增，归属到自己名下）；credentials 明文JSON在这里加密后落库，之后永不明文返回 */
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

/**
 * 修改解析平台账号：body: { name?, credentials? }
 * credentials 留空/不传则保留原有凭据不变（只改备注名的场景很常见，不想每次都重新填一遍AK/SK）
 */
providerRoutes.put("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const { ok, row } = await checkOwnership(c, id);
  if (!ok) return c.json({ error: "账号不存在或无权限" }, 404);

  const { name, credentials } = await c.req.json<{ name?: string; credentials?: Record<string, string> }>();
  const ts = now();

  if (credentials && Object.keys(credentials).length) {
    const plainJson = JSON.stringify(credentials);
    const encrypted = c.env.ENCRYPT_KEY ? await aesEncrypt(plainJson, c.env.ENCRYPT_KEY) : plainJson;
    await c.env.DB.prepare("UPDATE dns_providers SET name = ?, credentials = ?, updated_at = ? WHERE id = ?")
      .bind(name ?? row.name, encrypted, ts, id)
      .run();
  } else {
    await c.env.DB.prepare("UPDATE dns_providers SET name = ?, updated_at = ? WHERE id = ?")
      .bind(name ?? row.name, ts, id)
      .run();
  }
  return c.json({ ok: true });
});

providerRoutes.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const { ok } = await checkOwnership(c, id);
  if (!ok) return c.json({ error: "账号不存在或无权限" }, 404);
  await c.env.DB.prepare("DELETE FROM dns_providers WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

/** 测试凭据是否有效：尝试调用 listDomains */
providerRoutes.post("/:id/test", async (c) => {
  const id = Number(c.req.param("id"));
  const { ok, row } = await checkOwnership(c, id);
  if (!ok) return c.json({ error: "账号不存在或无权限" }, 404);
  try {
    const instance = await createProviderInstance(c.env, row.type, row.credentials);
    const domains = await instance.listDomains();
    return c.json({ ok: true, domainCount: domains.length });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 200);
  }
});

/**
 * 从平台侧拉取域名列表，仅用于展示供勾选，不写入数据库。
 * 返回结果会标注 imported: 是否已经导入过。
 */
providerRoutes.post("/:id/discover-domains", async (c) => {
  const id = Number(c.req.param("id"));
  const { ok, row } = await checkOwnership(c, id);
  if (!ok) return c.json({ error: "账号不存在或无权限" }, 404);

  const instance = await createProviderInstance(c.env, row.type, row.credentials);
  const domains = await instance.listDomains();

  const { results: imported } = await c.env.DB.prepare("SELECT domain_name FROM domains WHERE provider_id = ?")
    .bind(id)
    .all<{ domain_name: string }>();
  const importedSet = new Set(imported.map((r) => r.domain_name));

  return c.json(
    domains.map((d) => ({ domainName: d.domainName, status: d.status, imported: importedSet.has(d.domainName) }))
  );
});

/**
 * 同步"发现域名"弹窗里的勾选状态：
 * - 勾选但系统里还没有的 → 导入（非管理员会自动获得该域名的读写权限，因为是他自己的账号导入的）
 * - 没勾选但系统里已存在的 → 从系统中移除（同时清理该域名的权限/证书/收藏/备注）
 * 注意：移除只是把域名移出本系统管理，不会影响该域名在解析平台上的实际解析记录。
 */
providerRoutes.post("/:id/import-domains", async (c) => {
  const user = c.get("user") as JwtPayload;
  const id = Number(c.req.param("id"));
  const { ok } = await checkOwnership(c, id);
  if (!ok) return c.json({ error: "账号不存在或无权限" }, 404);

  const { domainNames, allDomainNames } = await c.req.json<{ domainNames: string[]; allDomainNames?: string[] }>();
  if (!Array.isArray(domainNames)) return c.json({ error: "参数格式不正确" }, 400);

  const selected = new Set(domainNames);

  // 先处理"取消勾选"的：在该平台账号下、本次发现列表里出现过、但没被勾选的，从系统中移除
  let removed = 0;
  if (Array.isArray(allDomainNames) && allDomainNames.length) {
    const { results: existing } = await c.env.DB.prepare(`SELECT id, domain_name FROM domains WHERE provider_id = ?`)
      .bind(id)
      .all<{ id: number; domain_name: string }>();

    const toRemove = (existing as any[]).filter(
      (d) => allDomainNames.includes(d.domain_name) && !selected.has(d.domain_name)
    );
    if (toRemove.length) {
      await batchDeleteDomains(c.env, toRemove.map((d) => d.id));
      removed = toRemove.length;
    }
  }

  // 再处理"勾选"的：导入或更新
  const maxRow = await c.env.DB.prepare("SELECT MAX(sort_order) as maxOrder FROM domains").first<{ maxOrder: number | null }>();
  let nextOrder = (maxRow?.maxOrder ?? 0) + 1;

  const ts = now();
  let importedCount = 0;
  for (const domainName of domainNames) {
    const res = await c.env.DB.prepare(
      `INSERT INTO domains (provider_id, domain_name, status, sort_order, synced_at, created_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(provider_id, domain_name) DO UPDATE SET status = excluded.status, synced_at = excluded.synced_at
       RETURNING id`
    )
      .bind(id, domainName, "active", nextOrder++, ts, ts)
      .first<{ id: number }>();
    importedCount++;

    // 非管理员：自己账号导入的域名，自动给自己开通读写权限，不然导入了也看不到
    if (user.role !== "admin" && res?.id) {
      await grantDomainPerm(c.env, user.uid, res.id, "readwrite");
    }
  }
  return c.json({ ok: true, imported: importedCount, removed });
});
