// 在 GitHub Actions（普通 Node.js 环境）里运行，复用 src/acme/* 的 ACME 客户端代码
// （纯 WebCrypto + fetch 实现，Node 20+ 原生支持，无需任何改动即可直接运行）。
// 通过调用已部署的 Worker 的 REST API 来完成 DNS-01 的 TXT 记录增删，
// 复用 Worker 里已经写好的10个解析平台适配器，这里不重新实现一遍。
import { AcmeClient } from "../src/acme/client";
import type { DnsProvider } from "../src/providers/interface";
import type { DnsRecord } from "../src/types";

export interface CiConfig {
  workerBaseUrl: string;
  apiKey: string;
  apiSecret: string;
  ciSecret: string;
  acmeEmail: string;
  acmeDirectoryUrl?: string;
  eabKid?: string;
  eabHmacKey?: string;
}

export interface IssueTask {
  domainId: number;
  certId: number;
  commonName: string;
  sans: string[];
  rootDomain: string;
}

/** 把 Worker 的 /api/domains/:id/records 接口包装成 AcmeClient 需要的 DnsProvider 接口 */
class RemoteDnsProvider implements DnsProvider {
  readonly type = "remote";
  constructor(private workerBaseUrl: string, private token: string, private domainId: number) {}

  private async req(path: string, init: RequestInit = {}) {
    const res = await fetch(`${this.workerBaseUrl}/api/domains/${this.domainId}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Worker接口返回非JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok) throw new Error(`Worker接口错误 (HTTP ${res.status}): ${JSON.stringify(data)}`);
    return data;
  }

  async listDomains(): Promise<never> {
    throw new Error("RemoteDnsProvider不支持listDomains");
  }
  async listRecords(): Promise<never> {
    throw new Error("RemoteDnsProvider不支持listRecords");
  }
  async updateRecord(): Promise<void> {
    throw new Error("RemoteDnsProvider不支持updateRecord");
  }

  async createRecord(_domain: string, record: Omit<DnsRecord, "id">): Promise<string> {
    const data = await this.req("/records", { method: "POST", body: JSON.stringify(record) });
    return data.id;
  }

  async deleteRecord(_domain: string, recordId: string): Promise<void> {
    await this.req(`/records/${encodeURIComponent(recordId)}`, { method: "DELETE" });
  }
}

async function reportResult(
  cfg: CiConfig,
  certId: number,
  result: { status: "issued" | "failed"; certPem?: string; keyPem?: string; expiresAt?: number; error?: string }
) {
  const res = await fetch(`${cfg.workerBaseUrl}/api/ci/certs/${certId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CI-Secret": cfg.ciSecret },
    body: JSON.stringify(result),
  });
  if (!res.ok) {
    throw new Error(`回调Worker失败 (HTTP ${res.status}): ${await res.text()}`);
  }
}

/** 对单个证书任务执行完整的 ACME DNS-01 签发流程，成功/失败都会回调 Worker 写回数据库 */
export async function runIssuance(cfg: CiConfig, task: IssueTask): Promise<void> {
  console.log(`[${task.commonName}] 开始申请证书${task.sans.length ? " (SAN: " + task.sans.join(",") + ")" : ""}`);
  try {
    const tokenRes = await fetch(`${cfg.workerBaseUrl}/api/open/ci-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: cfg.apiKey, apiSecret: cfg.apiSecret, domainId: task.domainId }),
    });
    if (!tokenRes.ok) throw new Error(`获取CI token失败: ${await tokenRes.text()}`);
    const { token } = (await tokenRes.json()) as { token: string };

    const dnsProvider = new RemoteDnsProvider(cfg.workerBaseUrl, token, task.domainId);

    const acme = await AcmeClient.create(cfg.acmeEmail, undefined, cfg.acmeDirectoryUrl);
    await acme.ensureAccount(cfg.eabKid && cfg.eabHmacKey ? { kid: cfg.eabKid, hmacKey: cfg.eabHmacKey } : undefined);

    const result = await acme.issueCertificate({
      commonName: task.commonName,
      sans: task.sans,
      dnsProvider,
      rootDomain: task.rootDomain,
      onLog: (msg) => console.log(`[${task.commonName}] ${msg}`),
    });

    console.log(`[${task.commonName}] 签发成功，回调Worker写回数据库...`);
    await reportResult(cfg, task.certId, {
      status: "issued",
      certPem: result.certPem,
      keyPem: result.keyPem,
      expiresAt: result.expiresAt,
    });
    console.log(`[${task.commonName}] 完成`);
  } catch (e: any) {
    console.error(`[${task.commonName}] 签发失败:`, e);
    try {
      await reportResult(cfg, task.certId, { status: "failed", error: e.message || String(e) });
    } catch (reportErr) {
      console.error(`[${task.commonName}] 回调失败结果也失败了:`, reportErr);
    }
    throw e;
  }
}

export function readCiConfigFromEnv(): CiConfig {
  const req = (name: string): string => {
    const v = process.env[name];
    if (!v) {
      console.error(`缺少环境变量 ${name}`);
      process.exit(1);
    }
    return v;
  };
  return {
    workerBaseUrl: req("WORKER_BASE_URL").replace(/\/$/, ""),
    apiKey: req("DNSMGR_API_KEY"),
    apiSecret: req("DNSMGR_API_SECRET"),
    ciSecret: req("CI_CALLBACK_SECRET"),
    acmeEmail: req("ACME_ACCOUNT_EMAIL"),
    acmeDirectoryUrl: process.env.ACME_DIRECTORY_URL || undefined,
    eabKid: process.env.ACME_EAB_KID || undefined,
    eabHmacKey: process.env.ACME_EAB_HMAC_KEY || undefined,
  };
}
