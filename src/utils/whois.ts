import { safeJson } from "./http";

export interface WhoisResult {
  domain: string;
  ldhName?: string;
  status?: string[];
  registrar?: string;
  nameservers?: string[];
  registeredAt?: string;
  expiresAt?: string;
  updatedAt?: string;
}

const RDAP_HEADERS = {
  Accept: "application/rdap+json",
  "User-Agent": "dnsmgr-cf/1.0 (+https://github.com/)",
};

/**
 * 查询域名的 RDAP（新一代Whois标准协议）信息。
 * 先查 IANA 官方的 RDAP 服务器索引找到该后缀对应的权威服务器直接查询；
 * 索引里找不到时，退回用 rdap.org 的通用转发代理兜底。
 */
export async function lookupWhois(domain: string): Promise<WhoisResult> {
  const tld = domain.split(".").pop()!.toLowerCase();
  let rdapBase: string | null = null;
  try {
    const bootstrapRes = await fetch("https://data.iana.org/rdap/dns.json", { headers: RDAP_HEADERS });
    const bootstrap = await safeJson(bootstrapRes, "RDAP索引");
    const entry = (bootstrap.services as any[]).find((s) => (s[0] as string[]).includes(tld));
    if (entry) rdapBase = (entry[1] as string[])[0];
  } catch {
    /* 索引查询失败就退回 rdap.org 兜底，不中断整体流程 */
  }

  const url = rdapBase
    ? `${rdapBase.replace(/\/$/, "")}/domain/${encodeURIComponent(domain)}`
    : `https://rdap.org/domain/${encodeURIComponent(domain)}`;
  const res = await fetch(url, { headers: RDAP_HEADERS });
  if (res.status === 404) throw new Error("查询不到该域名的注册信息（可能未注册，或注册局不支持RDAP）");
  if (res.status === 403) throw new Error("该域名后缀的RDAP服务器拒绝了查询请求（部分注册局有反爬限制），可以稍后重试");
  const data = await safeJson(res, "Whois查询");

  const events: Record<string, string> = {};
  for (const e of data.events || []) events[e.eventAction] = e.eventDate;

  return {
    domain,
    ldhName: data.ldhName,
    status: data.status,
    registrar: (data.entities || []).find((e: any) => e.roles?.includes("registrar"))?.vcardArray?.[1]?.find((f: any) => f[0] === "fn")?.[3],
    nameservers: (data.nameservers || []).map((n: any) => n.ldhName),
    registeredAt: events.registration,
    expiresAt: events.expiration,
    updatedAt: events["last changed"],
  };
}
