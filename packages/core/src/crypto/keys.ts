import { bytesToHex, hexToBytes, subtle, utf8 } from "../util/encoding";
import { canonicalize } from "./canonical";

export interface KeyMaterial {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
  /** First 32 hex chars of SHA-256 over the canonical {crv,kty,x,y}. Identical to Assentra's key fingerprint. */
  fingerprint: string;
}

export interface PersistentKey {
  material: KeyMaterial;
  /** Private JWK for storage (mode 0600). Never log it. */
  privateKeyJwk: JsonWebKey;
}

export async function sha256Hex(text: string): Promise<string> {
  return bytesToHex(await subtle().digest("SHA-256", utf8(text)));
}

export async function fingerprintJwk(jwk: JsonWebKey): Promise<string> {
  const canonical = canonicalize({ crv: jwk.crv ?? "", kty: jwk.kty ?? "", x: jwk.x ?? "", y: jwk.y ?? "" });
  return (await sha256Hex(canonical)).slice(0, 32);
}

export async function importPublicKeyJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") throw new Error("Only ECDSA P-256 public keys are supported");
  return subtle().importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
}

/** Generates an extractable ECDSA P-256 keypair so servers can persist it across restarts. */
export async function createSigningKey(): Promise<PersistentKey> {
  const pair = await subtle().generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const privateKeyJwk = await subtle().exportKey("jwk", pair.privateKey);
  const publicKeyJwk = await subtle().exportKey("jwk", pair.publicKey);
  return { material: { privateKey: pair.privateKey, publicKey: pair.publicKey, publicKeyJwk, fingerprint: await fingerprintJwk(publicKeyJwk) }, privateKeyJwk };
}

export async function loadSigningKey(privateKeyJwk: JsonWebKey): Promise<KeyMaterial> {
  if (!privateKeyJwk.d) throw new Error("Not a private JWK");
  const publicKeyJwk: JsonWebKey = { kty: privateKeyJwk.kty, crv: privateKeyJwk.crv, x: privateKeyJwk.x, y: privateKeyJwk.y };
  const privateKey = await subtle().importKey("jwk", privateKeyJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return { privateKey, publicKey: await importPublicKeyJwk(publicKeyJwk), publicKeyJwk, fingerprint: await fingerprintJwk(publicKeyJwk) };
}

/** ECDSA P-256 / SHA-256 signature as raw r‖s bytes. */
export async function signBytes(key: KeyMaterial, data: string): Promise<Uint8Array> {
  return new Uint8Array(await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, utf8(data)));
}

export async function verifySignature(publicKey: CryptoKey, signatureHex: string, data: string): Promise<boolean> {
  try {
    return await subtle().verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, hexToBytes(signatureHex), utf8(data));
  } catch {
    return false;
  }
}

/** Trusted counterparty keys: fingerprint → public JWK. */
export type KeyRegistry = Readonly<Record<string, JsonWebKey>>;

export async function buildRegistry(keys: readonly JsonWebKey[]): Promise<KeyRegistry> {
  const out: Record<string, JsonWebKey> = {};
  for (const k of keys) out[await fingerprintJwk(k)] = k;
  return out;
}
