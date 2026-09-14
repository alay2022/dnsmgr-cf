import { readCiConfigFromEnv, runIssuance, type IssueTask } from "./lib";

interface DueCert {
  cert_id: number;
  common_name: string;
  sans: string; // JSON字符串
  domain_id: number;
  root_domain: string;
}

async function main() {
  const cfg = readCiConfigFromEnv();

  const res = await fetch(`${cfg.workerBaseUrl}/api/ci/due-for-renewal`, {
    headers: { "X-CI-Secret": cfg.ciSecret },
  });
  if (!res.ok) {
    console.error(`获取待续签列表失败 (HTTP ${res.status}): ${await res.text()}`);
    process.exit(1);
  }
  const due = (await res.json()) as DueCert[];
  console.log(`共 ${due.length} 个证书需要续签`);

  let failedCount = 0;
  for (const item of due) {
    const task: IssueTask = {
      domainId: item.domain_id,
      certId: item.cert_id,
      commonName: item.common_name,
      sans: JSON.parse(item.sans || "[]"),
      rootDomain: item.root_domain,
    };
    try {
      await runIssuance(cfg, task);
    } catch {
      failedCount++;
      // 单个证书续签失败不影响其他证书，继续处理下一个
    }
  }

  console.log(`续签完成，成功 ${due.length - failedCount} 个，失败 ${failedCount} 个`);
  if (failedCount > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
