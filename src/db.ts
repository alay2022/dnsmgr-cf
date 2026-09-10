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
       ORDER BY d.id`
    ).all();
    return results;
  }
  const { results } = await env.DB.prepare(
    `SELECT d.*, p.type as provider_type, p.name as provider_name, up.perm
     FROM domains d
     JOIN user_domain_perms up ON up.domain_id = d.id
     JOIN dns_providers p ON d.provider_id = p.id
     WHERE up.user_id = ?
     ORDER BY d.id`
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
