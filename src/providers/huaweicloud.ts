import type { DnsDomain, DnsRecord } from "../types";
import type { DnsProvider, ProviderCredentials } from "./interface";
import { sha256Hex, hmacSha256Bytes, toHex } from "../utils/crypto";

/**
 * 华为云 DNS（dns.myhuaweicloud.com），签名算法为 SDK-HMAC-SHA256（结构与 AWS SigV4 类似）。
 * 凭据: { accessKeyId: string, secretAccessKey: string, region?: string }
 *
 * 🧩 骨架状态：签名核心逻辑（buildAuthHeader）已完整实现并可直接使用；
 * listDomains/listRecords/createRecord 等业务方法给出了标准的 Zone/RecordSet API 调用骨架，
 * 字段名与真实API基本一致，接入前建议对照华为云官方文档 https://support.huaweicloud.com/api-dns/
 * 核对一次 Zone 查询、RecordSet 增删改的请求体字段。
 */
const ENDPOINT = "https://dns.myhuaweicloud.com";

async function buildAuthHeader(opts: {
  method: string;
  path: string;
  query: string;
  body: string;
  ak: string;
  sk: string;
}): Promise<{ authorization: string; xDate: string }> {
  const now = new Date();
  const xDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // yyyyMMddTHHmmssZ
  const shortDate = xDate.slice(0, 8);

  const canonicalHeaders = `host:dns.myhuaweicloud.com\nx-sdk-date:${xDate}\n`;
  const signedHeaders = "host;x-sdk-date";
  const hashedPayload = await sha256Hex(opts.body);
  const canonicalRequest = [opts.method, opts.path, opts.query, canonicalHeaders, signedHeaders, hashedPayload].join("\n");

  const credentialScope = `${shortDate}/dns/sdk_request`;
  const hashedCanonicalRequest = await sha256Hex(canonicalRequest);
  const stringToSign = ["SDK-HMAC-SHA256", xDate, credentialScope, hashedCanonicalRequest].join("\n");

  const enc = new TextEncoder();
  const sigBytes = await hmacSha256Bytes(stringToSign, enc.encode(opts.sk));
  const signature = toHex(sigBytes);

  const authorization = `SDK-HMAC-SHA256 Access=${opts.ak}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { authorization, xDate };
}

export class HuaweiCloudProvider implements DnsProvider {
  readonly type = "huaweicloud";
  constructor(private creds: ProviderCredentials) {}

  private async req(method: string, path: string, body: Record<string, unknown> | null = null) {
    const bodyStr = body ? JSON.stringify(body) : "";
    const { authorization, xDate } = await buildAuthHeader({
      method,
      path,
      query: "",
      body: bodyStr,
      ak: this.creds.accessKeyId,
      sk: this.creds.secretAccessKey,
    });
    const res = await fetch(`${ENDPOINT}${path}`, {
      method,
      headers: {
        Authorization: authorization,
        "X-Sdk-Date": xDate,
        "Content-Type": "application/json",
      },
      body: bodyStr || undefined,
    });
    const data = (await res.json()) as any;
    if (!res.ok) throw new Error(`华为云DNS API错误(${res.status}): ${JSON.stringify(data)}`);
    return data;
  }

  async listDomains(): Promise<DnsDomain[]> {
    const data = await this.req("GET", "/v2/zones?limit=500");
    return (data.zones as any[]).map((z) => ({ domainName: (z.name as string).replace(/\.$/, "") }));
  }

  private async getZoneId(domain: string): Promise<string> {
    const data = await this.req("GET", `/v2/zones?name=${domain}.`);
    if (!data.zones?.length) throw new Error(`未找到域名 ${domain} 对应的 Zone`);
    return data.zones[0].id;
  }

  async listRecords(domain: string): Promise<DnsRecord[]> {
    const zoneId = await this.getZoneId(domain);
    const data = await this.req("GET", `/v2/zones/${zoneId}/recordsets?limit=500`);
    return (data.recordsets as any[]).map((r) => ({
      id: r.id,
      rr: (r.name as string).replace(`.${domain}.`, "").replace(`${domain}.`, "@"),
      type: r.type,
      value: (r.records as string[])[0],
      ttl: r.ttl,
    }));
  }

  async createRecord(domain: string, record: Omit<DnsRecord, "id">): Promise<string> {
    const zoneId = await this.getZoneId(domain);
    const name = record.rr === "@" ? `${domain}.` : `${record.rr}.${domain}.`;
    const data = await this.req("POST", `/v2/zones/${zoneId}/recordsets`, {
      name,
      type: record.type,
      records: [record.value],
      ttl: record.ttl || 300,
    });
    return data.id;
  }

  async updateRecord(domain: string, recordId: string, record: Omit<DnsRecord, "id">): Promise<void> {
    const zoneId = await this.getZoneId(domain);
    await this.req("PUT", `/v2/zones/${zoneId}/recordsets/${recordId}`, {
      records: [record.value],
      ttl: record.ttl || 300,
    });
  }

  async deleteRecord(domain: string, recordId: string): Promise<void> {
    const zoneId = await this.getZoneId(domain);
    await this.req("DELETE", `/v2/zones/${zoneId}/recordsets/${recordId}`);
  }
}
