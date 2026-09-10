import type { DnsDomain, DnsRecord } from "../types";
import type { DnsProvider, ProviderCredentials } from "./interface";
import { hmacSignBase64, randomToken } from "../utils/crypto";

/**
 * 阿里云 DNS（alidns.aliyuncs.com，经典 RPC 风格 HMAC-SHA1 签名）
 * 凭据: { accessKeyId: string, accessKeySecret: string }
 */
const ENDPOINT = "https://alidns.aliyuncs.com";

function percentEncode(str: string): string {
  return encodeURIComponent(str)
    .replace(/\+/g, "%20")
    .replace(/\*/g, "%2A")
    .replace(/%7E/g, "~");
}

export class AliyunProvider implements DnsProvider {
  readonly type = "aliyun";
  constructor(private creds: ProviderCredentials) {}

  private async call(action: string, params: Record<string, string | number | undefined>): Promise<any> {
    const { accessKeyId, accessKeySecret } = this.creds;
    const common: Record<string, string> = {
      Action: action,
      Version: "2015-01-09",
      AccessKeyId: accessKeyId,
      SignatureMethod: "HMAC-SHA1",
      SignatureVersion: "1.0",
      SignatureNonce: randomToken(8),
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      Format: "JSON",
    };
    const all: Record<string, string> = { ...common };
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) all[k] = String(v);
    }

    const sortedKeys = Object.keys(all).sort();
    const canonicalQuery = sortedKeys.map((k) => `${percentEncode(k)}=${percentEncode(all[k])}`).join("&");
    const stringToSign = `GET&${percentEncode("/")}&${percentEncode(canonicalQuery)}`;
    const signature = await hmacSignBase64(stringToSign, `${accessKeySecret}&`, "SHA-1");

    const finalQuery = `${canonicalQuery}&Signature=${percentEncode(signature)}`;
    const res = await fetch(`${ENDPOINT}/?${finalQuery}`);
    const data = (await res.json()) as any;
    if (data.Code) {
      throw new Error(`阿里云DNS API错误: ${data.Code} ${data.Message}`);
    }
    return data;
  }

  async listDomains(): Promise<DnsDomain[]> {
    const data = await this.call("DescribeDomains", { PageSize: 100 });
    return (data.Domains.Domain as any[]).map((d) => ({ domainName: d.DomainName }));
  }

  async listRecords(domain: string): Promise<DnsRecord[]> {
    const data = await this.call("DescribeDomainRecords", { DomainName: domain, PageSize: 500 });
    return (data.DomainRecords.Record as any[]).map((r) => ({
      id: r.RecordId,
      rr: r.RR,
      type: r.Type,
      value: r.Value,
      ttl: r.TTL,
      line: r.Line,
      priority: r.Priority,
      status: r.Status,
    }));
  }

  async createRecord(domain: string, record: Omit<DnsRecord, "id">): Promise<string> {
    const data = await this.call("AddDomainRecord", {
      DomainName: domain,
      RR: record.rr,
      Type: record.type,
      Value: record.value,
      TTL: record.ttl,
      Priority: record.priority,
      Line: record.line || "default",
    });
    return data.RecordId;
  }

  async updateRecord(domain: string, recordId: string, record: Omit<DnsRecord, "id">): Promise<void> {
    await this.call("UpdateDomainRecord", {
      RecordId: recordId,
      RR: record.rr,
      Type: record.type,
      Value: record.value,
      TTL: record.ttl,
      Priority: record.priority,
      Line: record.line || "default",
    });
  }

  async deleteRecord(_domain: string, recordId: string): Promise<void> {
    await this.call("DeleteDomainRecord", { RecordId: recordId });
  }
}
