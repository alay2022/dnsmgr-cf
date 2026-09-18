import { Hono } from "hono";
import type { Env, JwtPayload } from "../types";
import { requireAuth } from "../middleware/auth";
import { now } from "../db";
import { randomToken } from "../utils/crypto";

export const misubRoutes = new Hono<{ Bindings: Env }>();
misubRoutes.use("*", requireAuth);

/** 公开访问的订阅输出路由，不需要登录，挂载在 Worker 根路径（不是 /api 下面），代理客户端直接拿这个链接订阅 */
export const misubPublicRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /sub/:token?target=base64|clash|surge|singbox
 * 聚合该分组下所有启用的机场订阅 + 手动节点，去重后输出。
 * target=base64（默认）：直接输出base64编码的节点列表，V2rayN/V2rayNG/Shadowrocket等客户端可直接使用。
 * target=clash/surge/singbox：如果配置了 MISUB_SUBCONVERTER_URL（自建或公开的 subconverter 服务），
 * 转发给它做格式转换；没配置的话会提示改用 base64 格式。
 */
misubPublicRoutes.get("/sub/:token", async (c) => {
  const token = c.req.param("token");
  const profile = await c.env.DB.prepare("SELECT * FROM misub_profiles WHERE share_token = ?").bind(token).first<any>();
  if (!profile) return c.text("订阅链接不存在或已失效", 404);

  const subIds: number[] = JSON.parse(profile.subscription_ids || "[]");
  const nodeIds: number[] = JSON.parse(profile.node_ids || "[]");

  const allNodes: string[] = [];

  if (nodeIds.length) {
    const { results: nodes } = await c.env.DB.prepare(
      `SELECT url FROM misub_nodes WHERE id IN (${nodeIds.map(() => "?").join(",")}) AND enabled = 1`
    )
      .bind(...nodeIds)
      .all<{ url: string }>();
    allNodes.push(...nodes.map((n) => n.url));
  }

  if (subIds.length) {
    const { results: subs } = await c.env.DB.prepare(
      `SELECT url FROM misub_subscriptions WHERE id IN (${subIds.map(() => "?").join(",")}) AND enabled = 1`
    )
      .bind(...subIds)
      .all<{ url: string }>();
    for (const sub of subs) {
      try {
        const res = await fetch(sub.url, { headers: { "User-Agent": c.req.header("User-Agent") || "clash-verge/1.0" } });
        if (res.ok) allNodes.push(...decodeSubscriptionNodes(await res.text()));
      } catch {
        /* 单个订阅拉取失败不影响其他订阅，跳过 */
      }
    }
  }

  const uniqueNodes = [...new Set(allNodes)];
  const combined = uniqueNodes.join("\n");

  const target = c.req.query("target") || "base64";
  if (target === "base64") {
    return c.text(btoa(combined), 200, { "Content-Type": "text/plain; charset=utf-8" });
  }

  if (!c.env.MISUB_SUBCONVERTER_URL) {
    return c.text(
      `未配置 MISUB_SUBCONVERTER_URL，无法转换为 ${target} 格式。请在 wrangler.toml 中配置一个 subconverter 服务地址，或直接使用不带 target 参数的通用(base64)格式。`,
      501
    );
  }
  const subconverterUrl = `${c.env.MISUB_SUBCONVERTER_URL}?target=${target}&url=${encodeURIComponent(
    `data:text/plain;base64,${btoa(combined)}`
  )}`;
  return c.redirect(subconverterUrl, 302);
});

function scopeClause(user: JwtPayload, alias = ""): { where: string; bind: any[] } {
  const col = alias ? `${alias}.owner_user_id` : "owner_user_id";
  return user.role === "admin" ? { where: "1=1", bind: [] } : { where: `${col} = ?`, bind: [user.uid] };
}

// ---------------- 手动节点 ----------------
misubRoutes.get("/nodes", async (c) => {
  const user = c.get("user") as JwtPayload;
  const { where, bind } = scopeClause(user);
  const { results } = await c.env.DB.prepare(`SELECT * FROM misub_nodes WHERE ${where} ORDER BY sort_order, id`)
    .bind(...bind)
    .all();
  return c.json(results);
});

/** 批量导入节点：body: { text: string }，一行一个节点链接，自动从 #备注 里提取名字 */
misubRoutes.post("/nodes/batch-import", async (c) => {
  const user = c.get("user") as JwtPayload;
  const { text } = await c.req.json<{ text: string }>();
  const lines = (text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && /^[a-z0-9]+:\/\//i.test(l));
  if (!lines.length) return c.json({ error: "没有识别到有效的节点链接" }, 400);

  const ts = now();
  const maxRow = await c.env.DB.prepare("SELECT MAX(sort_order) as m FROM misub_nodes").first<{ m: number | null }>();
  let order = (maxRow?.m ?? 0) + 1;
  for (const url of lines) {
    const name = extractNodeName(url);
    await c.env.DB.prepare(
      "INSERT INTO misub_nodes (owner_user_id, name, url, enabled, sort_order, created_at, updated_at) VALUES (?,?,?,1,?,?,?)"
    )
      .bind(user.uid, name, url, order++, ts, ts)
      .run();
  }
  return c.json({ ok: true, imported: lines.length });
});

misubRoutes.put("/nodes/:id", async (c) => {
  const { name, url, enabled } = await c.req.json<{ name?: string; url?: string; enabled?: boolean }>();
  await c.env.DB.prepare("UPDATE misub_nodes SET name=?, url=?, enabled=?, updated_at=? WHERE id=?")
    .bind(name, url, enabled ? 1 : 0, now(), Number(c.req.param("id")))
    .run();
  return c.json({ ok: true });
});

misubRoutes.post("/nodes/batch-delete", async (c) => {
  const { ids } = await c.req.json<{ ids: number[] }>();
  if (!Array.isArray(ids) || !ids.length) return c.json({ error: "参数不能为空" }, 400);
  await c.env.DB.batch(ids.map((id) => c.env.DB.prepare("DELETE FROM misub_nodes WHERE id = ?").bind(id)));
  return c.json({ ok: true });
});

misubRoutes.put("/nodes/reorder", async (c) => {
  const { orderedIds } = await c.req.json<{ orderedIds: number[] }>();
  await c.env.DB.batch(
    orderedIds.map((id, i) => c.env.DB.prepare("UPDATE misub_nodes SET sort_order = ? WHERE id = ?").bind(i, id))
  );
  return c.json({ ok: true });
});

// ---------------- 机场订阅 ----------------
misubRoutes.get("/subscriptions", async (c) => {
  const user = c.get("user") as JwtPayload;
  const { where, bind } = scopeClause(user);
  const { results } = await c.env.DB.prepare(`SELECT * FROM misub_subscriptions WHERE ${where} ORDER BY sort_order, id`)
    .bind(...bind)
    .all();
  return c.json(results);
});

misubRoutes.post("/subscriptions", async (c) => {
  const user = c.get("user") as JwtPayload;
  const { name, url } = await c.req.json<{ name?: string; url: string }>();
  if (!url) return c.json({ error: "订阅地址必填" }, 400);
  const ts = now();
  const res = await c.env.DB.prepare(
    "INSERT INTO misub_subscriptions (owner_user_id, name, url, enabled, created_at, updated_at) VALUES (?,?,?,1,?,?)"
  )
    .bind(user.uid, name || url, url, ts, ts)
    .run();
  return c.json({ ok: true, id: res.meta.last_row_id });
});

misubRoutes.put("/subscriptions/:id", async (c) => {
  const { name, url, enabled } = await c.req.json<{ name?: string; url?: string; enabled?: boolean }>();
  await c.env.DB.prepare("UPDATE misub_subscriptions SET name=?, url=?, enabled=?, updated_at=? WHERE id=?")
    .bind(name, url, enabled ? 1 : 0, now(), Number(c.req.param("id")))
    .run();
  return c.json({ ok: true });
});

misubRoutes.post("/subscriptions/batch-delete", async (c) => {
  const { ids } = await c.req.json<{ ids: number[] }>();
  if (!Array.isArray(ids) || !ids.length) return c.json({ error: "参数不能为空" }, 400);
  await c.env.DB.batch(ids.map((id) => c.env.DB.prepare("DELETE FROM misub_subscriptions WHERE id = ?").bind(id)));
  return c.json({ ok: true });
});

/** 刷新某个机场订阅：拉取地址、统计节点数、解析流量/到期信息（订阅响应头 subscription-userinfo，各家机场大多支持） */
misubRoutes.post("/subscriptions/:id/refresh", async (c) => {
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare("SELECT * FROM misub_subscriptions WHERE id = ?").bind(id).first<any>();
  if (!row) return c.json({ error: "订阅不存在" }, 404);

  try {
    const res = await fetch(row.url, { headers: { "User-Agent": "clash-verge/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const nodeCount = decodeSubscriptionNodes(text).length;

    let trafficUsed: number | null = null;
    let trafficTotal: number | null = null;
    let expiresAt: number | null = null;
    const userinfo = res.headers.get("subscription-userinfo");
    if (userinfo) {
      const parts = Object.fromEntries(userinfo.split(";").map((p) => p.trim().split("=")));
      const upload = Number(parts.upload || 0);
      const download = Number(parts.download || 0);
      trafficUsed = upload + download;
      trafficTotal = parts.total ? Number(parts.total) : null;
      expiresAt = parts.expire ? Number(parts.expire) : null;
    }

    await c.env.DB.prepare(
      `UPDATE misub_subscriptions SET node_count=?, traffic_used=?, traffic_total=?, expires_at=?, last_checked_at=?, last_error=NULL, updated_at=? WHERE id=?`
    )
      .bind(nodeCount, trafficUsed, trafficTotal, expiresAt, now(), now(), id)
      .run();
    return c.json({ ok: true, nodeCount, trafficUsed, trafficTotal, expiresAt });
  } catch (e: any) {
    await c.env.DB.prepare("UPDATE misub_subscriptions SET last_error=?, last_checked_at=?, updated_at=? WHERE id=?")
      .bind(e.message, now(), now(), id)
      .run();
    return c.json({ ok: false, error: e.message }, 200);
  }
});

// ---------------- 订阅分组 (Profiles) ----------------
misubRoutes.get("/profiles", async (c) => {
  const user = c.get("user") as JwtPayload;
  const { where, bind } = scopeClause(user);
  const { results } = await c.env.DB.prepare(`SELECT * FROM misub_profiles WHERE ${where} ORDER BY id`)
    .bind(...bind)
    .all();
  return c.json(results);
});

misubRoutes.post("/profiles", async (c) => {
  const user = c.get("user") as JwtPayload;
  const { name, subscriptionIds, nodeIds } = await c.req.json<{ name: string; subscriptionIds: number[]; nodeIds: number[] }>();
  if (!name) return c.json({ error: "分组名称必填" }, 400);
  const ts = now();
  const res = await c.env.DB.prepare(
    "INSERT INTO misub_profiles (owner_user_id, name, share_token, subscription_ids, node_ids, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
  )
    .bind(user.uid, name, randomToken(16), JSON.stringify(subscriptionIds || []), JSON.stringify(nodeIds || []), ts, ts)
    .run();
  return c.json({ ok: true, id: res.meta.last_row_id });
});

misubRoutes.put("/profiles/:id", async (c) => {
  const { name, subscriptionIds, nodeIds } = await c.req.json<{ name?: string; subscriptionIds?: number[]; nodeIds?: number[] }>();
  const row = await c.env.DB.prepare("SELECT * FROM misub_profiles WHERE id = ?").bind(Number(c.req.param("id"))).first<any>();
  if (!row) return c.json({ error: "分组不存在" }, 404);
  await c.env.DB.prepare("UPDATE misub_profiles SET name=?, subscription_ids=?, node_ids=?, updated_at=? WHERE id=?")
    .bind(
      name ?? row.name,
      JSON.stringify(subscriptionIds ?? JSON.parse(row.subscription_ids)),
      JSON.stringify(nodeIds ?? JSON.parse(row.node_ids)),
      now(),
      row.id
    )
    .run();
  return c.json({ ok: true });
});

misubRoutes.delete("/profiles/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM misub_profiles WHERE id = ?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

// ---------------- 工具函数 ----------------

/** 从节点链接的 #fragment 部分提取备注名（URL编码），提取不到就返回协议名 */
function extractNodeName(url: string): string {
  const hashIdx = url.indexOf("#");
  if (hashIdx >= 0) {
    try {
      return decodeURIComponent(url.slice(hashIdx + 1));
    } catch {
      return url.slice(hashIdx + 1);
    }
  }
  return url.split("://")[0].toUpperCase();
}

/** 把订阅内容（可能是base64整体编码，也可能是明文每行一个节点）解析成节点链接数组 */
export function decodeSubscriptionNodes(text: string): string[] {
  const trimmed = text.trim();
  // 明文格式：直接就是一行一个节点链接
  if (/^[a-z0-9]+:\/\//i.test(trimmed)) {
    return trimmed.split("\n").map((l) => l.trim()).filter(Boolean);
  }
  // base64整体编码格式（机场订阅最常见）
  try {
    const decoded = atob(trimmed.replace(/-/g, "+").replace(/_/g, "/"));
    return decoded.split("\n").map((l) => l.trim()).filter((l) => /^[a-z0-9]+:\/\//i.test(l));
  } catch {
    return [];
  }
}
