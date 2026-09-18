import { Hono } from "hono";
import type { Env, JwtPayload } from "../types";
import { requireAuth } from "../middleware/auth";
import { now } from "../db";
import { randomToken } from "../utils/crypto";
import { connect } from "cloudflare:sockets";

export const misubRoutes = new Hono<{ Bindings: Env }>();
misubRoutes.use("*", requireAuth);

/** 公开访问的订阅输出路由，不需要登录，挂载在 Worker 根路径（不是 /api 下面） */
export const misubPublicRoutes = new Hono<{ Bindings: Env }>();

function scopeClause(user: JwtPayload, alias = ""): { where: string; bind: any[] } {
  const col = alias ? `${alias}.owner_user_id` : "owner_user_id";
  return user.role === "admin" ? { where: "1=1", bind: [] } : { where: `${col} = ?`, bind: [user.uid] };
}

// ==================== 手动节点 ====================

misubRoutes.get("/nodes", async (c) => {
  const user = c.get("user") as JwtPayload;
  const { where, bind } = scopeClause(user);
  const { results } = await c.env.DB.prepare(`SELECT * FROM misub_nodes WHERE ${where} ORDER BY sort_order, id`)
    .bind(...bind)
    .all();
  return c.json(results);
});

misubRoutes.get("/nodes/groups", async (c) => {
  const user = c.get("user") as JwtPayload;
  const { where, bind } = scopeClause(user);
  const { results } = await c.env.DB.prepare(
    `SELECT DISTINCT group_name FROM misub_nodes WHERE ${where} AND group_name IS NOT NULL AND group_name != '' ORDER BY group_name`
  )
    .bind(...bind)
    .all<{ group_name: string }>();
  return c.json(results.map((r) => r.group_name));
});

/**
 * 新增节点：body: { name?, group?, text }
 * text 支持单条链接，也支持多行粘贴批量导入（弹窗里的"新增手动节点"用这个）。
 * 单条时用 name 作为备注；多条时每行各自从 #fragment 提取备注（忽略传入的 name）。
 */
misubRoutes.post("/nodes", async (c) => {
  const user = c.get("user") as JwtPayload;
  const { name, group, text } = await c.req.json<{ name?: string; group?: string; text: string }>();
  const lines = (text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && /^[a-z0-9]+:\/\//i.test(l));
  if (!lines.length) return c.json({ error: "没有识别到有效的节点链接" }, 400);

  const ts = now();
  const maxRow = await c.env.DB.prepare("SELECT MAX(sort_order) as m FROM misub_nodes").first<{ m: number | null }>();
  let order = (maxRow?.m ?? 0) + 1;
  for (const url of lines) {
    const nodeName = lines.length === 1 && name ? name : extractNodeName(url);
    await c.env.DB.prepare(
      "INSERT INTO misub_nodes (owner_user_id, name, url, group_name, enabled, sort_order, created_at, updated_at) VALUES (?,?,?,?,1,?,?,?)"
    )
      .bind(user.uid, nodeName, url, group || null, order++, ts, ts)
      .run();
  }
  return c.json({ ok: true, imported: lines.length });
});

/** 把一个外部订阅地址的内容直接展开导入成一批手动节点（跟misub_subscriptions是两码事：这个是一次性拍平导入，不保留实时引用） */
misubRoutes.post("/nodes/import-subscription", async (c) => {
  const user = c.get("user") as JwtPayload;
  const { url, group } = await c.req.json<{ url: string; group?: string }>();
  if (!url) return c.json({ error: "请提供订阅地址" }, 400);

  let nodeUrls: string[];
  try {
    const res = await fetch(url, { headers: { "User-Agent": "clash-verge/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    nodeUrls = decodeSubscriptionNodes(await res.text());
  } catch (e: any) {
    return c.json({ error: `拉取订阅失败: ${e.message}` }, 500);
  }
  if (!nodeUrls.length) return c.json({ error: "该订阅没有解析出任何节点" }, 400);

  const ts = now();
  const maxRow = await c.env.DB.prepare("SELECT MAX(sort_order) as m FROM misub_nodes").first<{ m: number | null }>();
  let order = (maxRow?.m ?? 0) + 1;
  for (const nodeUrl of nodeUrls) {
    await c.env.DB.prepare(
      "INSERT INTO misub_nodes (owner_user_id, name, url, group_name, enabled, sort_order, created_at, updated_at) VALUES (?,?,?,?,1,?,?,?)"
    )
      .bind(user.uid, extractNodeName(nodeUrl), nodeUrl, group || null, order++, ts, ts)
      .run();
  }
  return c.json({ ok: true, imported: nodeUrls.length });
});

misubRoutes.put("/nodes/:id", async (c) => {
  const { name, url, group, enabled } = await c.req.json<{ name?: string; url?: string; group?: string; enabled?: boolean }>();
  await c.env.DB.prepare("UPDATE misub_nodes SET name=?, url=?, group_name=?, enabled=?, updated_at=? WHERE id=?")
    .bind(name, url, group || null, enabled === false ? 0 : 1, now(), Number(c.req.param("id")))
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

/**
 * 测速：对节点链接里解析出的 host:port 发起一次 TCP 连接（cloudflare:sockets），
 * 测的是"能不能连上、连接握手要多久"，不是真实代理转发速度（Workers 没法代理转发流量测真实带宽）。
 */
misubRoutes.post("/nodes/:id/speedtest", async (c) => {
  const row = await c.env.DB.prepare("SELECT url FROM misub_nodes WHERE id = ?").bind(Number(c.req.param("id"))).first<{ url: string }>();
  if (!row) return c.json({ error: "节点不存在" }, 404);

  const target = parseHostPort(row.url);
  if (!target) return c.json({ ok: false, error: "无法从该节点链接解析出服务器地址" }, 200);

  try {
    const start = Date.now();
    const socket = connect(`${target.host}:${target.port}`);
    await Promise.race([
      socket.opened,
      new Promise((_, reject) => setTimeout(() => reject(new Error("连接超时")), 5000)),
    ]);
    const latency = Date.now() - start;
    try {
      await socket.close();
    } catch {
      /* 关闭失败不影响测速结果 */
    }
    return c.json({ ok: true, latency });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message || "连接失败" }, 200);
  }
});

// ==================== 机场订阅 ====================

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
    .bind(name, url, enabled === false ? 0 : 1, now(), Number(c.req.param("id")))
    .run();
  return c.json({ ok: true });
});

misubRoutes.post("/subscriptions/batch-delete", async (c) => {
  const { ids } = await c.req.json<{ ids: number[] }>();
  if (!Array.isArray(ids) || !ids.length) return c.json({ error: "参数不能为空" }, 400);
  await c.env.DB.batch(ids.map((id) => c.env.DB.prepare("DELETE FROM misub_subscriptions WHERE id = ?").bind(id)));
  return c.json({ ok: true });
});

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

// ==================== 订阅组 (Profiles) ====================

misubRoutes.get("/profiles", async (c) => {
  const user = c.get("user") as JwtPayload;
  const { where, bind } = scopeClause(user);
  const { results } = await c.env.DB.prepare(`SELECT * FROM misub_profiles WHERE ${where} ORDER BY sort_order, id`)
    .bind(...bind)
    .all();
  return c.json(results);
});

misubRoutes.post("/profiles", async (c) => {
  const user = c.get("user") as JwtPayload;
  const { name, subscriptionIds, nodeIds } = await c.req.json<{ name: string; subscriptionIds: number[]; nodeIds: number[] }>();
  if (!name) return c.json({ error: "分组名称必填" }, 400);
  const ts = now();
  const maxRow = await c.env.DB.prepare("SELECT MAX(sort_order) as m FROM misub_profiles").first<{ m: number | null }>();
  const res = await c.env.DB.prepare(
    "INSERT INTO misub_profiles (owner_user_id, name, share_token, subscription_ids, node_ids, sort_order, enabled, is_public, created_at, updated_at) VALUES (?,?,?,?,?,?,1,1,?,?)"
  )
    .bind(user.uid, name, randomToken(16), JSON.stringify(subscriptionIds || []), JSON.stringify(nodeIds || []), (maxRow?.m ?? 0) + 1, ts, ts)
    .run();
  return c.json({ ok: true, id: res.meta.last_row_id });
});

misubRoutes.put("/profiles/:id", async (c) => {
  const body = await c.req.json<{
    name?: string;
    subscriptionIds?: number[];
    nodeIds?: number[];
    enabled?: boolean;
    isPublic?: boolean;
  }>();
  const row = await c.env.DB.prepare("SELECT * FROM misub_profiles WHERE id = ?").bind(Number(c.req.param("id"))).first<any>();
  if (!row) return c.json({ error: "分组不存在" }, 404);
  await c.env.DB.prepare(
    "UPDATE misub_profiles SET name=?, subscription_ids=?, node_ids=?, enabled=?, is_public=?, updated_at=? WHERE id=?"
  )
    .bind(
      body.name ?? row.name,
      JSON.stringify(body.subscriptionIds ?? JSON.parse(row.subscription_ids)),
      JSON.stringify(body.nodeIds ?? JSON.parse(row.node_ids)),
      body.enabled === undefined ? row.enabled : body.enabled ? 1 : 0,
      body.isPublic === undefined ? row.is_public : body.isPublic ? 1 : 0,
      now(),
      row.id
    )
    .run();
  return c.json({ ok: true });
});

misubRoutes.put("/profiles/reorder", async (c) => {
  const { orderedIds } = await c.req.json<{ orderedIds: number[] }>();
  await c.env.DB.batch(
    orderedIds.map((id, i) => c.env.DB.prepare("UPDATE misub_profiles SET sort_order = ? WHERE id = ?").bind(i, id))
  );
  return c.json({ ok: true });
});

misubRoutes.delete("/profiles/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM misub_profiles WHERE id = ?").bind(Number(c.req.param("id"))).run();
  await c.env.DB.prepare("DELETE FROM misub_access_log WHERE profile_id = ?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

/** 最近的访问日志（谁、什么时候订阅过这个分组），最多返回50条 */
misubRoutes.get("/profiles/:id/log", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT ip, user_agent, created_at FROM misub_access_log WHERE profile_id = ? ORDER BY created_at DESC LIMIT 50"
  )
    .bind(Number(c.req.param("id")))
    .all();
  return c.json(results);
});

// ==================== 工具函数 ====================

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

export function decodeSubscriptionNodes(text: string): string[] {
  const trimmed = text.trim();
  if (/^[a-z0-9]+:\/\//i.test(trimmed)) {
    return trimmed.split("\n").map((l) => l.trim()).filter(Boolean);
  }
  try {
    const decoded = atob(trimmed.replace(/-/g, "+").replace(/_/g, "/"));
    return decoded.split("\n").map((l) => l.trim()).filter((l) => /^[a-z0-9]+:\/\//i.test(l));
  } catch {
    return [];
  }
}

/** 从各协议节点链接里粗解析出 host:port，用于测速用的TCP连接目标 */
function parseHostPort(nodeUrl: string): { host: string; port: number } | null {
  try {
    if (nodeUrl.startsWith("vmess://")) {
      const json = JSON.parse(atob(nodeUrl.slice(8).split("#")[0]));
      return { host: json.add, port: Number(json.port) };
    }
    // vless:// trojan:// ss:// hysteria2:// 等都是标准URI形式 scheme://[userinfo@]host:port?...
    const u = new URL(nodeUrl.replace(/^ss:\/\//, "ss://").replace(/^hysteria2:\/\//, "https://").replace(/^vless:\/\//, "https://").replace(/^trojan:\/\//, "https://"));
    if (u.hostname && u.port) return { host: u.hostname, port: Number(u.port) };
    return null;
  } catch {
    return null;
  }
}

// ==================== 公开订阅输出 ====================

misubPublicRoutes.get("/sub/:token", async (c) => {
  const token = c.req.param("token");
  const profile = await c.env.DB.prepare("SELECT * FROM misub_profiles WHERE share_token = ?").bind(token).first<any>();
  if (!profile) return c.text("订阅链接不存在或已失效", 404);
  if (!profile.enabled) return c.text("该订阅组已被停用", 403);
  if (!profile.is_public) return c.text("该订阅组未开启公开访问", 403);

  // 记录访问日志 + 计数（不阻塞主流程）
  c.executionCtx.waitUntil(
    (async () => {
      await c.env.DB.prepare("UPDATE misub_profiles SET access_count = access_count + 1 WHERE id = ?").bind(profile.id).run();
      await c.env.DB.prepare("INSERT INTO misub_access_log (profile_id, ip, user_agent, created_at) VALUES (?,?,?,?)")
        .bind(profile.id, c.req.header("cf-connecting-ip") || "", c.req.header("User-Agent") || "", Math.floor(Date.now() / 1000))
        .run();
      // 保留最近200条，避免日志表无限增长
      await c.env.DB.prepare(
        `DELETE FROM misub_access_log WHERE profile_id = ? AND id NOT IN (
           SELECT id FROM misub_access_log WHERE profile_id = ? ORDER BY created_at DESC LIMIT 200
         )`
      )
        .bind(profile.id, profile.id)
        .run();
    })()
  );

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
      `未配置 MISUB_SUBCONVERTER_URL，无法转换为 ${target} 格式。请配置一个subconverter服务地址，或直接使用不带 target 参数的通用(base64)格式。`,
      501
    );
  }
  const subconverterUrl = `${c.env.MISUB_SUBCONVERTER_URL}?target=${target}&url=${encodeURIComponent(
    `data:text/plain;base64,${btoa(combined)}`
  )}`;
  return c.redirect(subconverterUrl, 302);
});
