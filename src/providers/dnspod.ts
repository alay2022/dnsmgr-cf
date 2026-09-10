import type { DnsDomain, DnsRecord } from "../types";
import type { DnsProvider, ProviderCredentials } from "./interface";
import { hmacSha256Bytes, sha256Hex, toHex } from "../utils/crypto";

/**
 * 腾讯云 DNSPod（新版 TC3-HMAC-SHA256 签名，dnspod.tencentcloudapi.com）
 * 凭据: { secretId: string, secretKey: string }
 */
const HOST = "dnspod.tencentcloudapi.com";
const SERVICE = "dnspod";
const VERSION = "2021-03-23";

export class DnsPodProvider implements DnsProvider {
  readonly type = "tencent";
  constructor(private creds: ProviderCredentials) {}

  private async call(action: string, payload: Record<string, unknown>): Promise<any> {
    const { secretId, secretKey } = this.creds;
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const body = JSON.stringify(payload);

    const canonicalHeaders = `content-type:application/json\nhost:${HOST}\nx-tc-action:${action.toLowerCase()}\n`;
    const signedHeaders = "content-type;host;x-tc-action";
    const hashedPayload = await sha256Hex(body);
    const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, hashedPayload].join("\n");

    const credentialScope = `${date}/${SERVICE}/tc3_request`;
    const hashedCanonicalRequest = await sha256Hex(canonicalRequest);
    const stringToSign = ["TC3-HMAC-SHA256", timestamp, credentialScope, hashedCanonicalRequest].join("\n");

    const enc = new TextEncoder();
    const kDate = await hmacSha256Bytes(date, enc.encode(`TC3${secretKey}`));
    const kService = await hmacSha256Bytes(SERVICE, kDate);
    const kSigning = await hmacSha256Bytes("tc3_request", kService);
    const signatureBytes = await hmacSha256Bytes(stringToSign, kSigning);
    const signature = toHex(signatureBytes);

    const authorization =
      `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const res = await fetch(`https://${HOST}`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        Host: HOST,
        "X-TC-Action": action,
        "X-TC-Timestamp": String(timestamp),
        "X-TC-Version": VERSION,
      },
      body,
    });
    const data = (await res.json()) as any;
    if (data.Response?.Error) {
      throw new Error(`DNSPod API错误: ${data.Response.Error.Code} ${data.Response.Error.Message}`);
    }
    return data.Response;
  }

  async listDomains(): Promise<DnsDomain[]> {
    const resp = await this.call("DescribeDomainList", { Type: "ALL", Limit: 100 });
    return (resp.DomainList as any[]).map((d) => ({ domainName: d.Name, status: d.Status }));
  }

  async listRecords(domain: string): Promise<DnsRecord[]> {
    const resp = await this.call("DescribeRecordList", { Domain: domain });
    return (resp.RecordList as any[]).map((r) => ({
      id: String(r.RecordId),
      rr: r.Name,
      type: r.Type,
      value: r.Value,
      ttl: r.TTL,
      line: r.Line,
      priority: r.MX,
      status: r.Status,
    }));
  }

  async createRecord(domain: string, record: Omit<DnsRecord, "id">): Promise<string> {
    const resp = await this.call("CreateRecord", {
      Domain: domain,
      SubDomain: record.rr,
      RecordType: record.type,
      RecordLine: record.line || "默认",
      Value: record.value,
      TTL: record.ttl,
      MX: record.priority,
    });
    return String(resp.RecordId);
  }

  async updateRecord(domain: string, recordId: string, record: Omit<DnsRecord, "id">): Promise<void> {
    await this.call("ModifyRecord", {
      Domain: domain,
      RecordId: Number(recordId),
      SubDomain: record.rr,
      RecordType: record.type,
      RecordLine: record.line || "默认",
      Value: record.value,
      TTL: record.ttl,
      MX: record.priority,
    });
  }

  async deleteRecord(domain: string, recordId: string): Promise<void> {
    await this.call("DeleteRecord", { Domain: domain, RecordId: Number(recordId) });
  }
}
