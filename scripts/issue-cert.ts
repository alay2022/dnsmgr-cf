import { readCiConfigFromEnv, runIssuance } from "./lib";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`缺少环境变量 ${name}`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const cfg = readCiConfigFromEnv();
  const domainId = Number(requireEnv("DOMAIN_ID"));
  const certId = Number(requireEnv("CERT_ID"));
  const commonName = requireEnv("COMMON_NAME");
  const sans = (process.env.SANS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const rootDomain = requireEnv("ROOT_DOMAIN");

  await runIssuance(cfg, { domainId, certId, commonName, sans, rootDomain });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
