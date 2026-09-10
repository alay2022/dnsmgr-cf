/**
 * 安全地把 fetch 响应解析为 JSON。
 * 如果对方返回的不是合法 JSON（比如 Cloudflare 525/502 之类的错误页、网关超时页面等），
 * 不会再抛出无意义的 "Unexpected token ... is not valid JSON"，
 * 而是把请求的 URL、HTTP状态码、以及响应体前200个字符一起带出来，方便定位到底是哪一步失败的。
 */
export async function safeJson(res: Response, context?: string): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.slice(0, 200).replace(/\s+/g, " ").trim();
    const prefix = context ? `[${context}] ` : "";
    throw new Error(
      `${prefix}请求 ${res.url} 返回了非JSON内容 (HTTP ${res.status} ${res.statusText})，原始内容片段: ${snippet || "(空)"}`
    );
  }
}
