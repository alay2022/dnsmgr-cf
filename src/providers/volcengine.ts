import type { DnsDomain, DnsRecord } from "../types";
import type { DnsProvider, ProviderCredentials } from "./interface";
import { sha256Hex, hmacSha256Bytes, toHex } from "../utils/crypto";

/**
 * 火山引擎 DNS（open.volcengineapi.com），签名算法与 AWS SigV4 结构一致（Volc-HMAC-SHA256）。
 * 凭据: { accessKeyId: string, secretAccessKey: string, region?: string(默认 cn-north-1) }
 * 官方文档：https://www.volcengine.com/docs/6758
 *
 * 🧩 骨架状态：签名逻辑已实现，业务字段（ZID/Value等）请对照实际API响应核对一次。
 */
const HOST = "open.volcengineapi.com";
const SERVICE = "DNS";

export class VolcEngineProvider implements DnsProvider {
  readonly type = "volcengine";
  constructor(private creds: ProviderCredentials) {}

  private async call(action: string, version: string, params: Record<string, string>, body: Record<string, unknown> = {}) {
    const region = this.creds.region || "cn-north-1";
    const now = new Date();
    const xDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const shortDate = xDate.slice(0, 8);
    const bodyStr = JSON.stringify(body);
    const hashedPayload = await sha256Hex(bodyStr);

    const query = new URLSearchParams({ Action: action, Version: version, ...params });
    const sortedQuery = [...query.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    const canonicalQueryString = sortedQuery.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");

    const canonicalHeaders = `host:${HOST}\nx-date:${xDate}\n`;
    const signedHeaders = "host;x-date";
    const canonicalRequest = ["POST", "/", canonicalQueryString, canonicalHeaders, signedHeaders, hashedPayload].join("\n");

    const credentialScope = `${shortDate}/${region}/${SERVICE}/request`;
    const hashedCanonicalRequest = await sha256Hex(canonicalRequest);
    const stringToSign = ["HMAC-SHA256", xDate, credentialScope, hashedCanonicalRequest].join("\n");

    const enc = new TextEncoder();
    const kDate = await hmacSha256Bytes(shortDate, enc.encode(this.creds.secretAccessKey));
    const kRegion = await hmacSha256Bytes(region, kDate);
    const kService = await hmacSha256Bytes(SERVICE, kRegion);
    const kSigning = await hmacSha256Bytes("request", kService);
    const signature = toHex(await hmacSha256Bytes(stringToSign, kSigning));

    const authorization =
      `HMAC-SHA256 Credential=${this.creds.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const res = await fetch(`https://${HOST}/?${canonicalQueryString}`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "X-Date": xDate,
        Host: HOST,
        "Content-Type": "application/json",
      },
      body: bodyStr,
    });
    const data = (await res.json()) as any;
    if (data.ResponseMetadata?.Error) {
      throw new Error(`火山引擎API错误: ${JSON.stringify(data.ResponseMetadata.Error)}`);
    }
    return data.Result;
  }

  async listDomains(): Promise<DnsDomain[]> {
    const result = await this.call("ListZones", "2018-08-01", {});
    return (result.Zones as any[]).map((z) => ({ domainName: z.ZoneName }));
  }

  async listRecords(domain: string): Promise<DnsRecord[]> {
    const result = await this.call("ListRecords", "2018-08-01", { ZoneName: domain });
    return (result.Records as any[]).map((r) => ({
      id: String(r.RecordID),
      rr: r.Host,
      type: r.Type,
      value: r.Value,
      ttl: r.TTL,
      line: r.Line,
    }));
  }

  async createRecord(domain: string, record: Omit<DnsRecord, "id">): Promise<string> {
    const result = await this.call("CreateRecord", "2018-08-01", {}, {
      ZoneName: domain,
      Host: record.rr,
      Type: record.type,
      Value: record.value,
      TTL: record.ttl,
      Line: record.line || "default",
    });
    return String(result.RecordID);
  }

  async updateRecord(_domain: string, recordId: string, record: Omit<DnsRecord, "id">): Promise<void> {
    await this.call("UpdateRecord", "2018-08-01", {}, {
      RecordID: Number(recordId),
      Host: record.rr,
      Type: record.type,
      Value: record.value,
      TTL: record.ttl,
      Line: record.line || "default",
    });
  }

  async deleteRecord(_domain: string, recordId: string): Promise<void> {
    await this.call("DeleteRecord", "2018-08-01", {}, { RecordID: Number(recordId) });
  }
}
