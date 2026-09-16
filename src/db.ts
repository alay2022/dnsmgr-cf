import type { Env } from "./types";

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export async function getUserByUsername(env: Env, username: string) {
  return env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first();
}

export async function getUserById(env: Env, id: number) {
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
}

export async function listUsers(env: Env) {
  const { results } = await env.DB.prepare(
    "SELECT id, username, role, status, email, created_at FROM users ORDER BY id"
  ).all();
  return results;
}

export async function createUser(env: Env, username: string, passwordHash: string, role: string, email?: string) {
  const ts = now();
  return env.DB.prepare(
    "INSERT INTO users (username, password_hash, role, status, email, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
  )
    .bind(username, passwordHash, role, "active", email ?? null, ts, ts)
    .run();
}

export async function userHasDomainPerm(env: Env, userId: number, domainId: number, needWrite = false) {
  const row = await env.DB.prepare(
    "SELECT perm FROM user_domain_perms WHERE user_id = ? AND domain_id = ?"
  )
    .bind(userId, domainId)
    .first<{ perm: string }>();
  if (!row) return false;
  if (needWrite && row.perm !== "readwrite") return false;
  return true;
}

export async function grantDomainPerm(env: Env, userId: number, domainId: number, perm: "readonly" | "readwrite") {
  const ts = now();
  return env.DB.prepare(
    `INSERT INTO user_domain_perms (user_id, domain_id, perm, created_at)
     VALUES (?,?,?,?)
     ON CONFLICT(user_id, domain_id) DO UPDATE SET perm = excluded.perm`
  )
    .bind(userId, domainId, perm, ts)
    .run();
}

export async function revokeDomainPerm(env: Env, userId: number, domainId: number) {
  return env.DB.prepare("DELETE FROM user_domain_perms WHERE user_id = ? AND domain_id = ?").bind(userId, domainId).run();
}

export async function listDomainsForUser(env: Env, userId: number, role: string) {
  if (role === "admin") {
    const { results } = await env.DB.prepare(
      `SELECT d.*, p.type as provider_type, p.name as provider_name
       FROM domains d JOIN dns_providers p ON d.provider_id = p.id
       ORDER BY d.sort_order ASC, d.id ASC`
    ).all();
    return results;
  }
  const { results } = await env.DB.prepare(
    `SELECT d.*, p.type as provider_type, p.name as provider_name, up.perm
     FROM domains d
     JOIN user_domain_perms up ON up.domain_id = d.id
     JOIN dns_providers p ON d.provider_id = p.id
     WHERE up.user_id = ?
     ORDER BY d.sort_order ASC, d.id ASC`
  )
    .bind(userId)
    .all();
  return results;
}

export async function getDomainById(env: Env, id: number) {
  return env.DB.prepare(
    `SELECT d.*, p.type as provider_type, p.name as provider_name, p.credentials as provider_credentials
     FROM domains d JOIN dns_providers p ON d.provider_id = p.id WHERE d.id = ?`
  )
    .bind(id)
    .first();
}

export async function insertAuditLog(env: Env, userId: number | null, action: string, target?: string, detail?: string, ip?: string) {
  return env.DB.prepare(
    "INSERT INTO audit_logs (user_id, action, target, detail, ip, created_at) VALUES (?,?,?,?,?,?)"
  )
    .bind(userId, action, target ?? null, detail ?? null, ip ?? null, now())
    .run();
}

/** 按传入顺序重新赋值 sort_order（数组下标即为新顺序） */
export async function reorderDomains(env: Env, orderedIds: number[]) {
  const stmts = orderedIds.map((id, index) =>
    env.DB.prepare("UPDATE domains SET sort_order = ? WHERE id = ?").bind(index, id)
  );
  await env.DB.batch(stmts);
}

/** 批量删除域名，同时清理关联的权限、证书、备注、收藏记录 */
export async function batchDeleteDomains(env: Env, domainIds: number[]) {
  for (const id of domainIds) {
    await env.DB.prepare("DELETE FROM user_domain_perms WHERE domain_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM ssl_certs WHERE domain_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM record_remarks WHERE domain_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM user_favorites WHERE domain_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM domains WHERE id = ?").bind(id).run();
  }
}

/** 获取某域名下所有记录的备注，返回 { [recordId]: remark } 映射，方便合并进 provider 返回的记录列表 */
export async function getRecordRemarks(env: Env, domainId: number): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare("SELECT record_id, remark FROM record_remarks WHERE domain_id = ?")
    .bind(domainId)
    .all<{ record_id: string; remark: string }>();
  const map: Record<string, string> = {};
  for (const row of results) map[row.record_id] = row.remark;
  return map;
}

export async function setRecordRemark(env: Env, domainId: number, recordId: string, remark: string) {
  return env.DB.prepare(
    `INSERT INTO record_remarks (domain_id, record_id, remark, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(domain_id, record_id) DO UPDATE SET remark = excluded.remark, updated_at = excluded.updated_at`
  )
    .bind(domainId, recordId, remark, now())
    .run();
}
