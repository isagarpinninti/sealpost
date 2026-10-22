import { createHash, timingSafeEqual } from "node:crypto";
import { KEY_SCOPES, keyRecord, type KeyScope, type ProjectConfig } from "./project";

export interface Principal {
  admin: boolean;
  scopes: ReadonlySet<KeyScope>;
  /** `master`, `key:<label>` or `open`. */
  actor: string;
}

export const ALL_SCOPES: ReadonlySet<KeyScope> = new Set(KEY_SCOPES);

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** The caller a bearer token stands for: the master key (admin), or a stored key that has not expired. */
export function principalForToken(config: ProjectConfig, masterKey: string, token: string): Principal | null {
  if (token === "") return null;
  if (masterKey !== "" && safeEqual(token, masterKey)) return { admin: true, scopes: ALL_SCOPES, actor: "master" };
  const stored = config.auth.keys[sha256(token)];
  if (!stored) return null;
  const rec = keyRecord(stored);
  if (rec.expiresAtIso && Date.parse(rec.expiresAtIso) <= Date.now()) return null;
  return { admin: false, scopes: new Set(rec.scopes), actor: `key:${rec.label}` };
}
