import type { DnsDomain, DnsRecord } from "../types";
import type { DnsProvider, ProviderCredentials } from "./interface";

/**
 * PowerDNS Authoritative Server REST API
 * 凭据: { apiUrl: string (如 https://ns.example.com:8081), apiKey: string, serverId?: string(默认 localhost) }
 */
export class PowerDnsProvider implements DnsProvider {
  readonly type = "powerdns";
  constructor(private creds: ProviderCredentials) {}

  private get base() {
    const server = this.creds.serverId || "localhost";
    return `${this.creds.apiUrl.replace(/\/$/, "")}/api/v1/servers/${server}`;
  }

  private async req(path: string, init: RequestInit = {}) {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: { "X-API-Key": this.creds.apiKey, "Content-Type": "application/json", ...(init.headers || {}) },
    });
    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      throw new Error(`PowerDNS API错误(${res.status}): ${text}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async listDomains(): Promise<DnsDomain[]> {
    const zones = (await this.req("/zones")) as any[];
    return zones.map((z) => ({ domainName: (z.name as string).replace(/\.$/, "") }));
  }

  async listRecords(domain: string): Promise<DnsRecord[]> {
    const zone = (await this.req(`/zones/${domain}.`)) as any;
    const out: DnsRecord[] = [];
    for (const rrset of zone.rrsets || []) {
      const rr = rrset.name === `${domain}.` ? "@" : rrset.name.replace(`.${domain}.`, "");
      for (const record of rrset.records) {
        out.push({
          id: `${rrset.name}|${rrset.type}|${record.content}`, // PowerDNS 以 rrset 为单位，用组合键标识单条记录
          rr,
          type: rrset.type,
          value: record.content,
          ttl: rrset.ttl,
        });
      }
    }
    return out;
  }

  /** PowerDNS 是按 rrset（同名同类型）整体 PATCH 的，这里做成「追加一条记录到 rrset」 */
  async createRecord(domain: string, record: Omit<DnsRecord, "id">): Promise<string> {
    const name = record.rr === "@" ? `${domain}.` : `${record.rr}.${domain}.`;
    const existing = await this.tryGetRrset(domain, name, record.type);
    const records = existing ? [...existing.records, { content: record.value, disabled: false }] : [{ content: record.value, disabled: false }];
    await this.req(`/zones/${domain}.`, {
      method: "PATCH",
      body: JSON.stringify({
        rrsets: [{ name, type: record.type, ttl: record.ttl || 3600, changetype: "REPLACE", records }],
      }),
    });
    return `${name}|${record.type}|${record.value}`;
  }

  async updateRecord(domain: string, recordId: string, record: Omit<DnsRecord, "id">): Promise<void> {
    // 先删除旧值对应的那一条，再新增新值（PowerDNS 无单条记录ID概念）
    await this.deleteRecord(domain, recordId);
    await this.createRecord(domain, record);
  }

  async deleteRecord(domain: string, recordId: string): Promise<void> {
    const [name, type, content] = recordId.split("|");
    const existing = await this.tryGetRrset(domain, name, type);
    if (!existing) return;
    const records = existing.records.filter((r: any) => r.content !== content);
    await this.req(`/zones/${domain}.`, {
      method: "PATCH",
      body: JSON.stringify({
        rrsets: [
          records.length
            ? { name, type, ttl: existing.ttl, changetype: "REPLACE", records }
            : { name, type, changetype: "DELETE" },
        ],
      }),
    });
  }

  private async tryGetRrset(domain: string, name: string, type: string): Promise<any | null> {
    const zone = (await this.req(`/zones/${domain}.`)) as any;
    return (zone.rrsets || []).find((r: any) => r.name === name && r.type === type) || null;
  }
}
