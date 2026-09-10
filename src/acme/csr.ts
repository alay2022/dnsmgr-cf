import {
  derSequence,
  derSet,
  derOid,
  derBitString,
  derOctetString,
  derIntegerFromNumber,
  derUtf8String,
  derContext0,
  rawEcdsaSigToDer,
  tlv,
} from "./asn1";

const OID_EC_PUBLIC_KEY = "1.2.840.10045.2.1";
const OID_PRIME256V1 = "1.2.840.10045.3.1.7";
const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const OID_COMMON_NAME = "2.5.4.3";
const OID_EXTENSION_REQUEST = "1.2.840.113549.1.9.14";
const OID_SUBJECT_ALT_NAME = "2.5.29.17";

function b64(bytes: Uint8Array | number[]): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let str = "";
  arr.forEach((b) => (str += String.fromCharCode(b)));
  return btoa(str);
}
export function b64url(bytes: Uint8Array | number[]): string {
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function pemWrap(b64str: string, label: string): string {
  const lines = b64str.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

function derGeneralNameDNS(dnsName: string): number[] {
  return tlv(0x82, [...new TextEncoder().encode(dnsName)]); // [2] IA5String, IMPLICIT
}

/**
 * 生成 ECDSA P-256 密钥对 + CSR（PKCS#10, DER），用于向 Let's Encrypt 申请证书。
 * 返回：csrDerB64Url（ACME finalize 接口用）、certKeyPkcs8Pem（证书私钥PEM，签发成功后与证书一起保存）
 */
export async function generateKeyPairAndCsr(commonName: string, sans: string[]) {
  const keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;

  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));

  const subjectPKInfo = derSequence(
    derSequence(derOid(OID_EC_PUBLIC_KEY), derOid(OID_PRIME256V1)),
    derBitString(rawPub, 0)
  );

  const subjectName = derSequence(derSet(derSequence(derOid(OID_COMMON_NAME), derUtf8String(commonName))));

  const allSans = [...new Set([commonName, ...sans])];
  const sanExtensionValue = derSequence(...allSans.map(derGeneralNameDNS));
  const extension = derSequence(derOid(OID_SUBJECT_ALT_NAME), derOctetString(new Uint8Array(sanExtensionValue)));
  const extensions = derSequence(extension); // SEQUENCE OF Extension
  const attribute = derSequence(derOid(OID_EXTENSION_REQUEST), derSet(extensions));
  const attributesTag = derContext0([attribute]); // [0] IMPLICIT Attributes

  const certificationRequestInfo = derSequence(
    derIntegerFromNumber(0),
    subjectName,
    subjectPKInfo,
    attributesTag
  );
  const criBytes = new Uint8Array(certificationRequestInfo);

  const sigRaw = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, criBytes)
  );
  const sigDer = rawEcdsaSigToDer(sigRaw);

  const signatureAlgorithm = derSequence(derOid(OID_ECDSA_SHA256));
  const csr = derSequence(certificationRequestInfo, signatureAlgorithm, derBitString(sigDer, 0));

  return {
    csrDer: new Uint8Array(csr),
    csrDerB64Url: b64url(csr),
    certPrivateKey: keyPair.privateKey,
    certKeyPkcs8Pem: pemWrap(b64(pkcs8), "PRIVATE KEY"),
  };
}
