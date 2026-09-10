// 全部基于 WebCrypto，Workers 运行时原生支持，无需额外依赖。

function bufToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBuf(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}
function b64urlEncode(buf: ArrayBuffer | string): string {
  const bytes = typeof buf === "string" ? new TextEncoder().encode(buf) : new Uint8Array(buf);
  let str = "";
  bytes.forEach((b) => (str += String.fromCharCode(b)));
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecodeToString(b64url: string): string {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(b64url.length + ((4 - (b64url.length % 4)) % 4), "=");
  return atob(b64);
}

// ---------------- 密码哈希 (PBKDF2-SHA256) ----------------
const PBKDF2_ITERATIONS = 100_000;

export async function hashPassword(password: string, saltHex?: string): Promise<string> {
  const salt = saltHex ? hexToBuf(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  const saltHexOut = saltHex ?? bufToHex(salt.buffer as ArrayBuffer);
  return `${PBKDF2_ITERATIONS}$${saltHexOut}$${bufToHex(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, saltHex, hashHex] = stored.split("$");
  if (!saltHex || !hashHex) return false;
  const recomputed = await hashPassword(password, saltHex);
  const recomputedHash = recomputed.split("$")[2];
  return timingSafeEqual(recomputedHash, hashHex);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------- JWT (HS256) ----------------
export async function signJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const encHeader = b64urlEncode(JSON.stringify(header));
  const encPayload = b64urlEncode(JSON.stringify(payload));
  const data = `${encHeader}.${encPayload}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return `${data}.${b64urlEncode(sig)}`;
}

export async function verifyJwt<T = Record<string, unknown>>(token: string, secret: string): Promise<T | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encHeader, encPayload, encSig] = parts;
  const data = `${encHeader}.${encPayload}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const sigBytes = Uint8Array.from(b64urlDecodeToString(encSig), (c) => c.charCodeAt(0));
  const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(data));
  if (!valid) return null;
  const payload = JSON.parse(b64urlDecodeToString(encPayload)) as T & { exp?: number };
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  return payload;
}

// ---------------- AES-GCM 凭据加密（存储各平台 AK/SK） ----------------
export async function aesEncrypt(plainText: string, base64Key: string): Promise<string> {
  const rawKey = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plainText));
  return `${bufToHex(iv.buffer as ArrayBuffer)}:${bufToHex(cipherBuf)}`;
}

export async function aesDecrypt(cipherText: string, base64Key: string): Promise<string> {
  const [ivHex, dataHex] = cipherText.split(":");
  const rawKey = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: hexToBuf(ivHex) }, key, hexToBuf(dataHex));
  return new TextDecoder().decode(plainBuf);
}

// ---------------- 通用 HMAC 签名（各云厂商API签名复用） ----------------
export async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bufToHex(sig);
}
export async function hmacSha256Bytes(message: string | Uint8Array, keyBytes: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const msg = typeof message === "string" ? new TextEncoder().encode(message) : message;
  const sig = await crypto.subtle.sign("HMAC", key, msg);
  return new Uint8Array(sig);
}
export async function sha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
  return bufToHex(digest);
}
export function toHex(bytes: Uint8Array): string {
  return bufToHex(bytes.buffer as ArrayBuffer);
}

/** 通用 HMAC 签名，返回 base64（阿里云等经典 RPC 签名使用 HMAC-SHA1 + base64） */
export async function hmacSignBase64(message: string, secret: string, alg: "SHA-1" | "SHA-256" = "SHA-1"): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: alg }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const bytes = new Uint8Array(sig);
  let str = "";
  bytes.forEach((b) => (str += String.fromCharCode(b)));
  return btoa(str);
}

export function randomToken(len = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return bufToHex(bytes.buffer as ArrayBuffer);
}
