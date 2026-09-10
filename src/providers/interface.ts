import type { DnsDomain, DnsRecord } from "../types";

/**
 * 所有解析平台适配器必须实现的统一接口。
 * 新增一个平台时，只需实现这五个方法即可自动接入
 * 域名管理 / 记录管理 / ACME DNS-01 自动验证 三大功能模块。
 */
export interface DnsProvider {
  readonly type: string;

  /** 拉取该账号下所有域名（用于「同步域名」功能） */
  listDomains(): Promise<DnsDomain[]>;

  /** 拉取某个域名下的全部解析记录 */
  listRecords(domain: string): Promise<DnsRecord[]>;

  /** 新增一条解析记录，返回平台侧记录ID */
  createRecord(domain: string, record: Omit<DnsRecord, "id">): Promise<string>;

  /** 修改一条解析记录 */
  updateRecord(domain: string, recordId: string, record: Omit<DnsRecord, "id">): Promise<void>;

  /** 删除一条解析记录 */
  deleteRecord(domain: string, recordId: string): Promise<void>;
}

/** 每个平台账号需要保存的凭据结构各不相同，用 Record<string,string> 兜底 */
export type ProviderCredentials = Record<string, string>;
