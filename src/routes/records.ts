import { Hono } from "hono";
import type { Env, JwtPayload, DnsRecord } from "../types";
import { requireAuth, requireDomainPerm } from "../middleware/auth";
import { getDomainById, insertAuditLog, getRecordRemarks, setRecordRemark } from "../db";
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
  const [records, remarks] = await Promise.all([instance.listRecords(domain.domain_name), getRecordRemarks(c.env, domainId)]);
  const merged = records.map((r) => ({ ...r, remark: remarks[r.id] || "" }));
  return c.json(merged);
});

recordRoutes.post("/:domainId/records", requireDomainPerm(true), async (c) => {
  const user = c.get("user") as JwtPayload;
  const domainId = Number(c.req.param("domainId"));
  const record = await c.req.json<Omit<DnsRecord, "id">>();
  const { domain, instance } = await getProviderForDomain(c.env, domainId);
  const recordId = await instance.createRecord(domain.domain_name, record);
  if (record.remark) await setRecordRemark(c.env, domainId, recordId, record.remark);
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
  if (record.remark !== undefined) await setRecordRemark(c.env, domainId, recordId, record.remark);
  await insertAuditLog(c.env, user.uid, "update_record", `${domain.domain_name}#${recordId}`, JSON.stringify(record));
  return c.json({ ok: true });
});

/** 单独更新备注，不触碰解析平台那边的记录内容（备注是纯本地数据） */
recordRoutes.put("/:domainId/records/:recordId/remark", requireDomainPerm(true), async (c) => {
  const domainId = Number(c.req.param("domainId"));
  const recordId = c.req.param("recordId");
  const { remark } = await c.req.json<{ remark: string }>();
  await setRecordRemark(c.env, domainId, recordId, remark || "");
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

/** 批量删除：body: { recordIds: string[] } */
recordRoutes.post("/:domainId/records/batch-delete", requireDomainPerm(true), async (c) => {
  const user = c.get("user") as JwtPayload;
  const domainId = Number(c.req.param("domainId"));
  const { recordIds } = await c.req.json<{ recordIds: string[] }>();
  if (!Array.isArray(recordIds) || !recordIds.length) return c.json({ error: "参数不能为空" }, 400);

  const { domain, instance } = await getProviderForDomain(c.env, domainId);
  let deleted = 0;
  const errors: string[] = [];
  for (const recordId of recordIds) {
    try {
      await instance.deleteRecord(domain.domain_name, recordId);
      deleted++;
    } catch (e: any) {
      errors.push(`${recordId}: ${e.message}`);
    }
  }
  await insertAuditLog(c.env, user.uid, "batch_delete_records", `${domain.domain_name}`, `deleted=${deleted}`);
  return c.json({ ok: true, deleted, errors });
});
