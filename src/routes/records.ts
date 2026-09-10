import { Hono } from "hono";
import type { Env, JwtPayload, DnsRecord } from "../types";
import { requireAuth, requireDomainPerm } from "../middleware/auth";
import { getDomainById, insertAuditLog } from "../db";
import { createProviderInstance } from "../providers/registry";

export const recordRoutes = new Hono<{ Bindings: Env }>();
recordRoutes.use("*", requireAuth);

async function getProviderForDomain(env: Env, domainId: number) {
  const domain = await getDomainById(env, domainId);
  if (!domain) throw new Error("域名不存在");
  const instance = await createProviderInstance(env, (domain as any).provider_type, (domain as any).provider_credentials);
  return { domain: domain as any, instance };
}

recordRoutes.get("/:domainId/records", requireDomainPerm(false), async (c) => {
  const domainId = Number(c.req.param("domainId"));
  const { domain, instance } = await getProviderForDomain(c.env, domainId);
  const records = await instance.listRecords(domain.domain_name);
  return c.json(records);
});

recordRoutes.post("/:domainId/records", requireDomainPerm(true), async (c) => {
  const user = c.get("user") as JwtPayload;
  const domainId = Number(c.req.param("domainId"));
  const record = await c.req.json<Omit<DnsRecord, "id">>();
  const { domain, instance } = await getProviderForDomain(c.env, domainId);
  const recordId = await instance.createRecord(domain.domain_name, record);
  await insertAuditLog(c.env, user.uid, "create_record", `${domain.domain_name}`, JSON.stringify(record));
  return c.json({ ok: true, id: recordId });
});

recordRoutes.put("/:domainId/records/:recordId", requireDomainPerm(true), async (c) => {
  const user = c.get("user") as JwtPayload;
  const domainId = Number(c.req.param("domainId"));
  const recordId = c.req.param("recordId");
  const record = await c.req.json<Omit<DnsRecord, "id">>();
  const { domain, instance } = await getProviderForDomain(c.env, domainId);
  await instance.updateRecord(domain.domain_name, recordId, record);
  await insertAuditLog(c.env, user.uid, "update_record", `${domain.domain_name}#${recordId}`, JSON.stringify(record));
  return c.json({ ok: true });
});

recordRoutes.delete("/:domainId/records/:recordId", requireDomainPerm(true), async (c) => {
  const user = c.get("user") as JwtPayload;
  const domainId = Number(c.req.param("domainId"));
  const recordId = c.req.param("recordId");
  const { domain, instance } = await getProviderForDomain(c.env, domainId);
  await instance.deleteRecord(domain.domain_name, recordId);
  await insertAuditLog(c.env, user.uid, "delete_record", `${domain.domain_name}#${recordId}`);
  return c.json({ ok: true });
});
