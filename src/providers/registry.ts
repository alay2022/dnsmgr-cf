import type { Env } from "../types";
import type { DnsProvider } from "./interface";
import { aesDecrypt } from "../utils/crypto";
import { CloudflareProvider } from "./cloudflare";
import { DnsPodProvider } from "./dnspod";
import { AliyunProvider } from "./aliyun";
import { NamesiloProvider } from "./namesilo";
import { PowerDnsProvider } from "./powerdns";
import { HuaweiCloudProvider } from "./huaweicloud";
import { BaiduCloudProvider } from "./baiducloud";
import { WestProvider } from "./west";
import { VolcEngineProvider } from "./volcengine";
import { DnslaProvider } from "./dnsla";

export const SUPPORTED_PROVIDER_TYPES = [
  "cloudflare",
  "tencent",
  "aliyun",
  "namesilo",
  "powerdns",
  "huaweicloud",
  "baiducloud",
  "west",
  "volcengine",
  "dnsla",
] as const;

export async function createProviderInstance(env: Env, type: string, encryptedCredentials: string): Promise<DnsProvider> {
  const raw = env.ENCRYPT_KEY ? await aesDecrypt(encryptedCredentials, env.ENCRYPT_KEY) : encryptedCredentials;
  const creds = JSON.parse(raw);

  switch (type) {
    case "cloudflare":
      return new CloudflareProvider(creds);
    case "tencent":
      return new DnsPodProvider(creds);
    case "aliyun":
      return new AliyunProvider(creds);
    case "namesilo":
      return new NamesiloProvider(creds);
    case "powerdns":
      return new PowerDnsProvider(creds);
    case "huaweicloud":
      return new HuaweiCloudProvider(creds);
    case "baiducloud":
      return new BaiduCloudProvider(creds);
    case "west":
      return new WestProvider(creds);
    case "volcengine":
      return new VolcEngineProvider(creds);
    case "dnsla":
      return new DnslaProvider(creds);
    default:
      throw new Error(`不支持的解析平台类型: ${type}`);
  }
}
