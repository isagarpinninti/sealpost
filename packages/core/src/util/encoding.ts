const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8 = (s: string): Uint8Array<ArrayBuffer> => encoder.encode(s) as Uint8Array<ArrayBuffer>;
export const fromUtf8 = (b: Uint8Array): string => decoder.decode(b);

export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(view, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error("Invalid hex string");
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  if (/[^A-Za-z0-9_-]/.test(s)) throw new Error("Invalid base64url string");
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function subtle(): SubtleCrypto {
  const impl = globalThis.crypto?.subtle;
  if (!impl) throw new Error("Web Crypto API unavailable (requires Node 20+, a modern browser or an edge runtime).");
  return impl;
}

/** Standard (RFC 4648 §4) base64, with `=` padding. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function base64ToBytes(s: string): Uint8Array<ArrayBuffer> {
  const clean = s.replace(/\s+/g, "");
  if (/[^A-Za-z0-9+/=]/.test(clean)) throw new Error("Invalid base64 string");
  const binary = atob(clean);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
