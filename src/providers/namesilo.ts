import type { DnsDomain, DnsRecord } from "../types";
import type { DnsProvider, ProviderCredentials } from "./interface";

/**
 * Namesilo API（简单 APIKey + query string 方式，返回 XML）
 * 凭据: { apiKey: string }
 */
const API = "https://www.namesilo.com/api";

// --- 极简 XML 提取工具（Workers 运行时无 DOMParser，避免引入额外依赖） ---
function xmlAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g");
  const out: string[] = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1].trim());
  return out;
}
function xmlOne(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(xml);
  return m ? m[1].trim() : undefined;
}
/** 按 <resource_record>...</resource_record> 等重复块切分，逐块解析 */
function xmlBlocks(xml: string, blockTag: string): string[] {
  const re = new RegExp(`<${blockTag}>([\\s\\S]*?)<\\/${blockTag}>`, "g");
  const out: string[] = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

export class NamesiloProvider implements DnsProvider {
  readonly type = "namesilo";
  constructor(private creds: ProviderCredentials) {}

  private async call(op: string, params: Record<string, string | number | undefined>): Promise<string> {
    const qs = new URLSearchParams({
      version: "1",
      type: "xml",
      key: this.creds.apiKey,
      ...Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])),
    });
    const res = await fetch(`${API}/${op}?${qs.toString()}`);
    const xml = await res.text();
    const code = xmlOne(xml, "code");
    if (code && code !== "300") {
      throw new Error(`Namesilo API错误(${code}): ${xmlOne(xml, "detail")}`);
    }
    return xml;
  }

  async listDomains(): Promise<DnsDomain[]> {
    const xml = await this.call("listDomains", {});
    return xmlAll(xml, "domain").map((name) => ({ domainName: name }));
  }

  async listRecords(domain: string): Promise<DnsRecord[]> {
    const xml = await this.call("dnsListRecords", { domain });
    return xmlBlocks(xml, "resource_record").map((block) => {
      const host = xmlOne(block, "host") || domain;
      const rr = host === domain ? "@" : host.replace(`.${domain}`, "");
      const distance = xmlOne(block, "distance");
      return {
        id: xmlOne(block, "record_id") || "",
        rr,
        type: xmlOne(block, "type") || "",
        value: xmlOne(block, "value") || "",
        ttl: Number(xmlOne(block, "ttl") || 3600),
        priority: distance ? Number(distance) : undefined,
      };
    });
  }

  async createRecord(domain: string, record: Omit<DnsRecord, "id">): Promise<string> {
    const xml = await this.call("dnsAddRecord", {
      domain,
      rrtype: record.type,
      rrhost: record.rr === "@" ? "" : record.rr,
      rrvalue: record.value,
      rrttl: record.ttl,
      rrdistance: record.priority,
    });
    return xmlOne(xml, "record_id") || "";
  }

  async updateRecord(domain: string, recordId: string, record: Omit<DnsRecord, "id">): Promise<void> {
    await this.call("dnsUpdateRecord", {
      domain,
      rrid: recordId,
      rrhost: record.rr === "@" ? "" : record.rr,
      rrvalue: record.value,
      rrttl: record.ttl,
      rrdistance: record.priority,
    });
  }

  async deleteRecord(domain: string, recordId: string): Promise<void> {
    await this.call("dnsDeleteRecord", { domain, rrid: recordId });
  }
}
