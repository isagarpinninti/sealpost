import { randomBytes } from "node:crypto";
import { diskStorage, type Storage } from "./storage";
import { createDkimKeyPair, createSigningKey, loadDkimKeyPair, loadSigningKey, type DkimKeyPair, type KeyMaterial } from "@sealpost/core";

async function readStored(path: string, storage: Storage): Promise<JsonWebKey | null> {
  try {
    return (JSON.parse(await storage.readText(path)) as { privateKeyJwk: JsonWebKey }).privateKeyJwk;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Could not read key at ${path}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function store(path: string, privateKeyJwk: JsonWebKey, storage: Storage): Promise<void> {
  await storage.writeText(path, `${JSON.stringify({ createdAt: new Date().toISOString(), privateKeyJwk }, null, 2)}\n`, 0o600);
}

/** The ECDSA P-256 key that signs `evw_` delivery receipts (mode 0600). */
export async function loadOrCreateReceiptKey(path: string, storage: Storage = diskStorage): Promise<KeyMaterial> {
  const stored = await readStored(path, storage);
  if (stored) return loadSigningKey(stored);
  // Under the storage lock, so two processes starting on an empty database end up with the same key.
  return storage.withLock(async () => {
    const again = await readStored(path, storage);
    if (again) return loadSigningKey(again);
    const created = await createSigningKey();
    await store(path, created.privateKeyJwk, storage);
    return created.material;
  });
}

/** The 2048-bit RSA key that signs every outbound message with DKIM (mode 0600). */
export async function loadOrCreateDkimKey(path: string, storage: Storage = diskStorage): Promise<DkimKeyPair> {
  const stored = await readStored(path, storage);
  if (stored) return loadDkimKeyPair(stored);
  return storage.withLock(async () => {
    const again = await readStored(path, storage);
    if (again) return loadDkimKeyPair(again);
    const created = await createDkimKeyPair();
    await store(path, created.privateKeyJwk, storage);
    return created.keys;
  });
}

/** 32 random bytes for HMACs that must survive restarts (unsubscribe tokens). Mode 0600. */
export async function loadOrCreateSecret(path: string, storage: Storage = diskStorage): Promise<Buffer> {
  try {
    const hex = (await storage.readText(path)).trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, "hex");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return storage.withLock(async () => {
    try {
      const hex = (await storage.readText(path)).trim();
      if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, "hex");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const secret = randomBytes(32);
    await storage.writeText(path, `${secret.toString("hex")}\n`, 0o600);
    return secret;
  });
}
