import type { Env } from "./types";

/**
 * 触发指定的 GitHub Actions workflow（workflow_dispatch 事件）。
 * 需要 env.GITHUB_TOKEN 是一个有 `repo` + `workflow` 权限的 Personal Access Token。
 */
export async function triggerGithubWorkflow(
  env: Env,
  workflowFile: string,
  inputs: Record<string, string>
): Promise<void> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) {
    throw new Error("未配置 GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO，无法触发证书签发流程");
  }
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${workflowFile}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "dnsmgr-cf-worker",
    },
    body: JSON.stringify({
      ref: env.GITHUB_REF || "main",
      inputs,
    }),
  });
  if (res.status !== 204) {
    // GitHub 触发成功时返回 204 No Content；其他情况都是错误
    const text = await res.text();
    throw new Error(`触发 GitHub Actions 失败 (HTTP ${res.status}): ${text || "(空响应)"}`);
  }
}