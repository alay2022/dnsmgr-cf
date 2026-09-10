import type { DnsDomain, DnsRecord } from "../types";
import type { DnsProvider, ProviderCredentials } from "./interface";
import { sha256Hex } from "../utils/crypto";

/**
 * 西部数码 (west.cn) API，签名方式：token = SHA256(username + apiPassword + timestamp)，
 * 表单方式 POST。凭据: { username: string, apiPassword: string }
 * 官方文档：https://www.west.cn/CustomerCenter/doc/apiv2.html
 *
 * 🧩 骨架状态：签名与请求结构已给出，字段名请以账号实际开通的API版本文档为准
 * （西部数码历史上有 v1/v2 两套API，此处按v2骨架实现）。
 */
const API = "https://api.west.cn/API/v2";

export class WestProvider implements DnsProvider {
  readonly type = "west";
  constructor(private creds: ProviderCredentials) {}

  private async req(action: string, params: Record<string, string | number | undefined>) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const token = await sha256Hex(`${this.creds.username}${this.creds.apiPassword}${timestamp}`);
    const form = new URLSearchParams({
      username: this.creds.username,
      time: timestamp,
      token,
      act: action,
      ...Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])),
    });
    const res = await fetch(`${API}/domain/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const data = (await res.json()) as any;
    if (data.errno && data.errno !== 0) {
      throw new Error(`西部数码API错误(${data.errno}): ${data.errmsg}`);
    }
    return data;
  }

  async listDomains(): Promise<DnsDomain[]> {
    const data = await this.req("domainlist", {});
    return (data.list as any[]).map((d) => ({ domainName: d.domain }));
  }

  async listRecords(domain: string): Promise<DnsRecord[]> {
    const data = await this.req("recordlist", { domain });
    return (data.list as any[]).map((r) => ({
      id: String(r.id),
      rr: r.host,
      type: r.type,
      value: r.value,
      ttl: r.ttl,
      line: r.line,
    }));
  }

  async createRecord(domain: string, record: Omit<DnsRecord, "id">): Promise<string> {
    const data = await this.req("recordcreate", {
      domain,
      host: record.rr,
      type: record.type,
      value: record.value,
      ttl: record.ttl,
      line: record.line || "默认",
    });
    return String(data.id);
  }

  async updateRecord(domain: string, recordId: string, record: Omit<DnsRecord, "id">): Promise<void> {
    await this.req("recordedit", {
      domain,
      id: recordId,
      host: record.rr,
      type: record.type,
      value: record.value,
      ttl: record.ttl,
      line: record.line || "默认",
    });
  }

  async deleteRecord(domain: string, recordId: string): Promise<void> {
    await this.req("recorddel", { domain, id: recordId });
  }
}
