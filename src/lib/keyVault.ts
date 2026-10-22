import { createDkimKeyPair, createSigningKey, loadDkimKeyPair, loadSigningKey, type DkimKeyPair, type KeyMaterial } from "@sealpost/core";

const DB = "sealpost-vault";
const STORE = "keys";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB unavailable"));
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = run(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

export interface LocalKeys {
  receipt: KeyMaterial;
  dkim: DkimKeyPair;
  persistent: boolean;
}

/**
 * Local demo mode only: the receipt (ECDSA) and DKIM (RSA) keys live in this browser's IndexedDB. A server never
 * does this: it keeps keys on disk with mode 0600. Falls back to session-only keys when storage is unavailable.
 */
export async function loadOrCreateLocalKeys(): Promise<LocalKeys> {
  try {
    const db = await open();
    const r = (await tx(db, "readonly", (s) => s.get("receipt"))) as JsonWebKey | undefined;
    const d = (await tx(db, "readonly", (s) => s.get("dkim"))) as JsonWebKey | undefined;
    if (r && d) return { receipt: await loadSigningKey(r), dkim: await loadDkimKeyPair(d), persistent: true };
    const cr = await createSigningKey();
    const cd = await createDkimKeyPair();
    await tx(db, "readwrite", (s) => s.put(cr.privateKeyJwk, "receipt"));
    await tx(db, "readwrite", (s) => s.put(cd.privateKeyJwk, "dkim"));
    return { receipt: cr.material, dkim: cd.keys, persistent: true };
  } catch {
    return { receipt: (await createSigningKey()).material, dkim: (await createDkimKeyPair()).keys, persistent: false };
  }
}

export async function resetLocalKeys(): Promise<void> {
  const db = await open();
  await tx(db, "readwrite", (s) => s.clear());
}
