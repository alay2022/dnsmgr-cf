function b64url(bytes: Uint8Array | ArrayBuffer | string): string {
  const arr = typeof bytes === "string" ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
  let str = "";
  arr.forEach((b) => (str += String.fromCharCode(b)));
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(s.length + ((4 - (s.length % 4)) % 4), "=");
  const bin = atob(padded);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export interface AcmeAccountKey {
  privateKey: CryptoKey;
  publicJwk: { kty: "EC"; crv: "P-256"; x: string; y: string };
}

export async function generateAcmeAccountKey(): Promise<AcmeAccountKey> {
  const keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
  return {
    privateKey: keyPair.privateKey,
    publicJwk: { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! },
  };
}

/** 用于导出账户私钥以持久化保存（跨 Worker 请求复用同一 ACME 账户） */
export async function exportAccountKeyPkcs8B64(privateKey: CryptoKey): Promise<string> {
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", privateKey);
  return b64url(pkcs8);
}
export async function importAccountKeyFromPkcs8B64(b64Str: string): Promise<CryptoKey> {
  const bin = atob(b64Str.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", bytes, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
}

/** RFC 7638 JWK Thumbprint（用于 DNS-01 keyAuthorization） */
export async function jwkThumbprint(jwk: { kty: string; crv: string; x: string; y: string }): Promise<string> {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return b64url(digest);
}

/**
 * 对 ACME 请求做 JWS 签名（ES256, Flattened JSON Serialization）。
 * url/nonce 由调用方提供；首次请求(newAccount)用 jwk，之后的请求用 kid。
 */
export async function signAcmeJws(opts: {
  privateKey: CryptoKey;
  payload: Record<string, unknown> | ""; // POST-as-GET 时传空字符串
  url: string;
  nonce: string;
  jwk?: { kty: string; crv: string; x: string; y: string };
  kid?: string;
}): Promise<Record<string, unknown>> {
  const protectedHeader: Record<string, unknown> = {
    alg: "ES256",
    nonce: opts.nonce,
    url: opts.url,
  };
  if (opts.kid) protectedHeader.kid = opts.kid;
  else protectedHeader.jwk = opts.jwk;

  const encProtected = b64url(JSON.stringify(protectedHeader));
  const encPayload = opts.payload === "" ? "" : b64url(JSON.stringify(opts.payload));
  const signingInput = `${encProtected}.${encPayload}`;

  const sigRaw = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, opts.privateKey, new TextEncoder().encode(signingInput))
  );
  // JWS ES256 使用 raw r||s（非DER），与 CSR 签名不同，无需 rawEcdsaSigToDer 转换
  const signature = b64url(sigRaw);

  return { protected: encProtected, payload: encPayload, signature };
}

/**
 * 生成 External Account Binding (EAB) JWS，ZeroSSL / Google Trust Services 等CA
 * 要求注册账户时必须附带，用于证明你持有该CA颁发的 Key ID + HMAC Key。
 */
export async function signEabJws(opts: {
  accountJwk: { kty: string; crv: string; x: string; y: string };
  eabKid: string;
  eabHmacKeyB64Url: string;
  url: string;
}): Promise<Record<string, unknown>> {
  const protectedHeader = { alg: "HS256", kid: opts.eabKid, url: opts.url };
  const encProtected = b64url(JSON.stringify(protectedHeader));
  const encPayload = b64url(JSON.stringify(opts.accountJwk));
  const signingInput = `${encProtected}.${encPayload}`;

  const keyBytes = b64urlToBytes(opts.eabHmacKeyB64Url);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput)));

  return { protected: encProtected, payload: encPayload, signature: b64url(sig) };
}
