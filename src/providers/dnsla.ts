import type { DnsDomain, DnsRecord } from "../types";
import type { DnsProvider, ProviderCredentials } from "./interface";

/**
 * DNSLA（dns.la）开放API，鉴权方式为 APIKey + APISecret（Bearer/HMAC均支持，此处按官方
 * 「Basic Auth 风格」的 APIKey:APISecret base64 实现，具体以 https://www.dns.la/docs/api 为准）。
 * 凭据: { apiKey: string, apiSecret: string }
 *
 * 🧩 骨架状态：请求结构已给出，鉴权头请对照官方最新文档核对（DNSLA 曾多次调整鉴权方式）。
 */
const API = "https://api.dns.la/api";

export class DnslaProvider implements DnsProvider {
  readonly type = "dnsla";
  constructor(private creds: ProviderCredentials) {}

  private async req(method: string, path: string, body: Record<string, unknown> | null = null) {
    const basic = btoa(`${this.creds.apiKey}:${this.creds.apiSecret}`);
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json()) as any;
    if (data.code && data.code !== 200) {
      throw new Error(`DNSLA API错误(${data.code}): ${data.message}`);
    }
    return data.data ?? data;
  }

  async listDomains(): Promise<DnsDomain[]> {
    const data = await this.req("GET", "/domain?page=1&pagesize=200");
    return (data.records as any[]).map((d) => ({ domainName: d.domain }));
  }

  private async getDomainId(domain: string): Promise<string> {
    const data = await this.req("GET", `/domain?keyword=${encodeURIComponent(domain)}`);
    const found = (data.records as any[])?.find((d) => d.domain === domain);
    if (!found) throw new Error(`未找到域名 ${domain}`);
    return found.id;
  }

  async listRecords(domain: string): Promise<DnsRecord[]> {
    const domainId = await this.getDomainId(domain);
    const data = await this.req("GET", `/domainRecord?domainId=${domainId}&pagesize=500`);
    return (data.records as any[]).map((r) => ({
      id: r.id,
      rr: r.host,
      type: r.type,
      value: r.data,
      ttl: r.ttl,
      line: r.viewName,
    }));
  }

  async createRecord(domain: string, record: Omit<DnsRecord, "id">): Promise<string> {
    const domainId = await this.getDomainId(domain);
    const data = await this.req("POST", "/domainRecord", {
      domainId,
      host: record.rr,
      type: record.type,
      data: record.value,
      ttl: record.ttl,
    });
    return data.id;
  }

  async updateRecord(domain: string, recordId: string, record: Omit<DnsRecord, "id">): Promise<void> {
    const domainId = await this.getDomainId(domain);
    await this.req("PUT", `/domainRecord/${recordId}`, {
      domainId,
      host: record.rr,
      type: record.type,
      data: record.value,
      ttl: record.ttl,
    });
  }

  async deleteRecord(_domain: string, recordId: string): Promise<void> {
    await this.req("DELETE", `/domainRecord/${recordId}`);
  }
}
