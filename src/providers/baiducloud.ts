import type { DnsDomain, DnsRecord } from "../types";
import type { DnsProvider, ProviderCredentials } from "./interface";
import { hmacSha256Bytes, toHex } from "../utils/crypto";

/**
 * 百度智能云 DNS（BOD, dns.baidubce.com），签名算法 bce-auth-v1。
 * 凭据: { accessKeyId: string, secretAccessKey: string }
 *
 * 🧩 骨架状态：bce-auth-v1 签名已实现；listRecords/createRecord 等对照
 * https://cloud.baidu.com/doc/DNS/s/ujwvyk3ee 的字段基本给出，
 * 接入前建议用一次真实请求核对 zoneName/rr 等字段命名。
 */
const HOST = "dns.baidubce.com";

async function bceSign(opts: { method: string; path: string; query: string; ak: string; sk: string; xbceDate: string }) {
  const authStringPrefix = `bce-auth-v1/${opts.ak}/${opts.xbceDate}/1800`;
  const enc = new TextEncoder();
  const signingKeyBytes = await hmacSha256Bytes(authStringPrefix, enc.encode(opts.sk));
  const signingKey = toHex(signingKeyBytes);

  const canonicalHeaders = `host:${encodeURIComponent(HOST)}`;
  const canonicalRequest = [opts.method, opts.path, opts.query, canonicalHeaders].join("\n");
  const sigBytes = await hmacSha256Bytes(canonicalRequest, new TextEncoder().encode(signingKey));
  const signature = toHex(sigBytes);

  return `${authStringPrefix}/host/${signature}`;
}

export class BaiduCloudProvider implements DnsProvider {
  readonly type = "baiducloud";
  constructor(private creds: ProviderCredentials) {}

  private async req(method: string, path: string, body: Record<string, unknown> | null = null) {
    const xbceDate = new Date().toISOString().split(".")[0] + "Z";
    const authorization = await bceSign({
      method,
      path,
      query: "",
      ak: this.creds.accessKeyId,
      sk: this.creds.secretAccessKey,
      xbceDate,
    });
    const res = await fetch(`https://${HOST}${path}`, {
      method,
      headers: {
        Authorization: authorization,
        Host: HOST,
        "x-bce-date": xbceDate,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json()) as any;
    if (!res.ok) throw new Error(`百度云DNS API错误(${res.status}): ${JSON.stringify(data)}`);
    return data;
  }

  async listDomains(): Promise<DnsDomain[]> {
    const data = await this.req("GET", "/v1/zone");
    return (data.zones as any[]).map((z) => ({ domainName: z.name }));
  }

  async listRecords(domain: string): Promise<DnsRecord[]> {
    const data = await this.req("GET", `/v1/zone/${domain}/record`);
    return (data.records as any[]).map((r) => ({
      id: r.id,
      rr: r.rr,
      type: r.type,
      value: r.value,
      ttl: r.ttl,
      line: r.line,
      priority: r.priority,
    }));
  }

  async createRecord(domain: string, record: Omit<DnsRecord, "id">): Promise<string> {
    const data = await this.req("POST", `/v1/zone/${domain}/record`, {
      rr: record.rr,
      type: record.type,
      value: record.value,
      ttl: record.ttl,
      line: record.line || "默认",
    });
    return data.id;
  }

  async updateRecord(domain: string, recordId: string, record: Omit<DnsRecord, "id">): Promise<void> {
    await this.req("PUT", `/v1/zone/${domain}/record/${recordId}`, {
      rr: record.rr,
      type: record.type,
      value: record.value,
      ttl: record.ttl,
      line: record.line || "默认",
    });
  }

  async deleteRecord(domain: string, recordId: string): Promise<void> {
    await this.req("DELETE", `/v1/zone/${domain}/record/${recordId}`);
  }
}
