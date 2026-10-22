import { resolveMx as dnsResolveMx } from "node:dns/promises";
import { synthesizeDnsRecords, type DkimKeyPair, type DnsRecord, type DomainProfile, type KeyMaterial, type MxResolver } from "@sealpost/core";
import { loadOrCreateDkimKey, loadOrCreateReceiptKey, loadOrCreateSecret } from "./key";
import { LedgerWriter } from "./ledger";
import { allDomains, dkimKeyPathFor, type Project } from "./project";
import type { RunningSink } from "./smtp/sink";

export interface Runtime {
  project: Project;
  /** Key of the default domain. */
  dkim: DkimKeyPair;
  /** Keys of every sending domain loaded so far, by lowercase domain name. */
  dkimKeys: Map<string, DkimKeyPair>;
  issuer: KeyMaterial;
  /** Server secret for HMAC tokens that must survive restarts. */
  secret: Buffer;
  ledger: LedgerWriter;
  /** Idempotency keys of sends that are in flight right now. */
  inflight: Set<string>;
  /** A long-lived sink (the Studio server). Without one, `sink` transport starts a short-lived sink per send. */
  sink: RunningSink | null;
  queue: Promise<unknown>;
  /** Timestamps (ms) of recent SMTP hand-offs, for `limits.sendsPerMinute`. */
  sendTimes: number[];
  /** DNS TXT lookup used to fetch DKIM keys of received mail. Defaults to the system resolver; tests inject one. */
  resolveTxt?: (name: string) => Promise<string[][]>;
}

export async function openRuntime(project: Project, opts: { sink?: RunningSink | null } = {}): Promise<Runtime> {
  const dkim = await loadOrCreateDkimKey(project.paths.dkimKey, project.storage);
  const rt: Runtime = { project, dkim, dkimKeys: new Map([[project.config.domain.domain.toLowerCase(), dkim]]), issuer: await loadOrCreateReceiptKey(project.paths.receiptKey, project.storage), secret: await loadOrCreateSecret(project.paths.secret, project.storage), ledger: new LedgerWriter(project.paths.ledger, project.storage), inflight: new Set(), sink: opts.sink ?? null, queue: Promise.resolve(), sendTimes: [] };
  for (const d of project.config.domains) await dkimFor(rt, d);
  return rt;
}

/** Serialises the parts of a send that must not race: idempotency checks, ledger sequence, queue and suppression files. */
export function exclusive<T>(rt: Runtime, fn: () => Promise<T>): Promise<T> {
  // The in-process queue orders callers in this process; the storage lock (a no-op on disk) orders processes that share a database.
  const guarded = (): Promise<T> => rt.project.storage.withLock(fn);
  const run = rt.queue.then(guarded, guarded);
  rt.queue = run.catch(() => undefined);
  return run;
}

/** The sending domain named `name`, or the default one. Throws for an unknown domain. */
export function domainFor(rt: Runtime, name?: string): DomainProfile {
  if (name === undefined || name === "") return rt.project.config.domain;
  const found = allDomains(rt.project.config).find((d) => d.domain.toLowerCase() === name.toLowerCase());
  if (!found) throw new Error(`Unknown sending domain '${name}'. Configured: ${allDomains(rt.project.config).map((d) => d.domain).join(", ")}`);
  return found;
}

/** The DKIM key for a domain, created (mode 0600) on first use. */
export async function dkimFor(rt: Runtime, profile: DomainProfile): Promise<DkimKeyPair> {
  const id = profile.domain.toLowerCase();
  const cached = rt.dkimKeys.get(id);
  if (cached) return cached;
  const keys = await loadOrCreateDkimKey(dkimKeyPathFor(rt.project, id), rt.project.storage);
  rt.dkimKeys.set(id, keys);
  return keys;
}

/** Public key for the sink to verify against: any configured domain whose selector matches. */
export function resolveDkimPublicKey(rt: Runtime, domain: string, selector: string): JsonWebKey | undefined {
  const profile = allDomains(rt.project.config).find((d) => d.domain.toLowerCase() === domain.toLowerCase() && d.dkimSelector === selector);
  return profile ? rt.dkimKeys.get(profile.domain.toLowerCase())?.publicKeyJwk : undefined;
}

/** The DNS records to publish for a domain; the MX record names `inbound.mxHost` when receiving is enabled. */
export async function dnsRecordsFor(rt: Runtime, profile: DomainProfile): Promise<DnsRecord[]> {
  const inbound = rt.project.config.inbound;
  return synthesizeDnsRecords(profile, (await dkimFor(rt, profile)).publicKeySpkiBase64, inbound.enabled && inbound.mxHost ? { mxHost: inbound.mxHost } : {});
}

/** Options for `checkDnsRecords`: MX is verified (against `inbound.mxHost`) only when receiving is enabled. */
export function dnsCheckOptions(rt: Runtime, profile: DomainProfile): { spfInclude?: string; resolveMx?: MxResolver; expectMxHost?: string } {
  const inbound = rt.project.config.inbound;
  return { spfInclude: profile.spfInclude, ...(inbound.enabled ? { resolveMx: (n: string) => dnsResolveMx(n), expectMxHost: inbound.mxHost } : {}) };
}

/** Milliseconds until another send is allowed under `limits.sendsPerMinute` (0 = go ahead). */
export function rateWait(rt: Runtime, now = Date.now()): number {
  const limit = rt.project.config.limits.sendsPerMinute;
  if (limit <= 0) return 0;
  rt.sendTimes = rt.sendTimes.filter((t) => now - t < 60_000);
  return rt.sendTimes.length < limit ? 0 : Math.max(1000, rt.sendTimes[0] + 60_000 - now);
}

/** Records an SMTP hand-off for rate limiting. */
export function noteSend(rt: Runtime, now = Date.now()): void {
  if (rt.project.config.limits.sendsPerMinute > 0) rt.sendTimes.push(now);
}

const INFLIGHT_TTL_MS = 5 * 60_000;

/**
 * Reserves an idempotency key for a send that is about to start. In-process that is a set; with shared storage it is also
 * written to the database, so a second Sealpost process cannot start the identical send. Call inside `exclusive`.
 */
export async function reserveKey(rt: Runtime, key: string): Promise<void> {
  rt.inflight.add(key);
  if (!rt.project.storage.shared) return;
  const now = Date.now();
  const doc = await readInflight(rt);
  await rt.project.storage.writeText(rt.project.paths.inflight, JSON.stringify({ ...doc, [key]: now + INFLIGHT_TTL_MS }), 0o600);
}

/** Releases a reservation. Safe to call whether or not the caller holds the lock. */
export async function releaseKey(rt: Runtime, key: string): Promise<void> {
  rt.inflight.delete(key);
  if (!rt.project.storage.shared) return;
  const doc = await readInflight(rt);
  if (key in doc) {
    delete doc[key];
    await rt.project.storage.writeText(rt.project.paths.inflight, JSON.stringify(doc), 0o600);
  }
}

/** Keys reserved by this and (with shared storage) any other process. Expired reservations are ignored. */
export async function readInflight(rt: Runtime): Promise<Record<string, number>> {
  if (!rt.project.storage.shared) return {};
  try {
    const doc = JSON.parse(await rt.project.storage.readText(rt.project.paths.inflight)) as Record<string, number>;
    const now = Date.now();
    return Object.fromEntries(Object.entries(doc).filter(([, exp]) => exp > now));
  } catch {
    return {};
  }
}
