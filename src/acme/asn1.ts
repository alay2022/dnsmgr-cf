// 最小可用的 DER 编码工具，仅覆盖构造 PKCS#10 CSR (ECDSA P-256) 所需的类型。
// 不依赖任何第三方库，纯手写，便于在 Workers 运行时使用。

function lengthBytes(len: number): number[] {
  if (len < 0x80) return [len];
  const bytes: number[] = [];
  let l = len;
  while (l > 0) {
    bytes.unshift(l & 0xff);
    l >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

export function tlv(tag: number, content: number[]): number[] {
  return [tag, ...lengthBytes(content.length), ...content];
}

/** WebCrypto ECDSA 签名默认返回 raw(r||s) 拼接，PKCS#10/X.509 要求 DER SEQUENCE{INTEGER r, INTEGER s} */
export function rawEcdsaSigToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  const r = raw.slice(0, half);
  const s = raw.slice(half);
  return new Uint8Array(derSequence(derInteger(r), derInteger(s)));
}

export function derSequence(...children: number[][]): number[] {
  return tlv(0x30, children.flat());
}
export function derSet(...children: number[][]): number[] {
  return tlv(0x31, children.flat());
}
export function derInteger(bytes: Uint8Array): number[] {
  let arr = [...bytes];
  // 去掉多余的前导0，但若最高位为1需补0x00防止被解释为负数
  while (arr.length > 1 && arr[0] === 0 && (arr[1] & 0x80) === 0) arr.shift();
  if (arr[0] & 0x80) arr = [0, ...arr];
  return tlv(0x02, arr);
}
export function derIntegerFromNumber(n: number): number[] {
  const bytes: number[] = [];
  let v = n;
  if (v === 0) return tlv(0x02, [0]);
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return derInteger(new Uint8Array(bytes));
}
export function derBitString(bytes: Uint8Array, unusedBits = 0): number[] {
  return tlv(0x03, [unusedBits, ...bytes]);
}
export function derOctetString(bytes: Uint8Array): number[] {
  return tlv(0x04, [...bytes]);
}
export function derNull(): number[] {
  return [0x05, 0x00];
}
export function derOid(oid: string): number[] {
  const parts = oid.split(".").map(Number);
  const bytes: number[] = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    if (p < 128) {
      bytes.push(p);
    } else {
      const chunks: number[] = [];
      let v = p;
      while (v > 0) {
        chunks.unshift(v & 0x7f);
        v >>= 7;
      }
      for (let i = 0; i < chunks.length - 1; i++) chunks[i] |= 0x80;
      bytes.push(...chunks);
    }
  }
  return tlv(0x06, bytes);
}
export function derUtf8String(str: string): number[] {
  return tlv(0x0c, [...new TextEncoder().encode(str)]);
}
export function derPrintableString(str: string): number[] {
  return tlv(0x13, [...new TextEncoder().encode(str)]);
}
/** [n] 显式上下文标签，用于 CSR 的 attributes 字段 (Context-specific, constructed, tag 0) */
export function derContext0(children: number[][]): number[] {
  return tlv(0xa0, children.flat());
}
/** 显式 EXPLICIT 标签包装（用于 extensionRequest 内部 SEQUENCE） */
export function derExplicit(tagNum: number, children: number[][]): number[] {
  return tlv(0xa0 | tagNum, children.flat());
}
