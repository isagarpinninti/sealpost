import {
  addSuppression,
  autoFillSampleVariables,
  buildLedgerRecord,
  buildRegistry,
  composeSignedMessage,
  evaluateDispatchPreflight,
  generateDeliveryReceipt,
  newMessageId,
  removeSuppression,
  sha256OfMime,
  synthesizeDnsRecords,
  verifyDeliveryLedger,
  verifyDeliveryReceipt,
  verifyDkimSignature,
  type DeliveryLedgerRecord,
  type DkimVerification,
  type DnsRecord,
  type DomainProfile,
  type EmailTemplate,
  type LedgerVerification,
  type PreflightResult,
  type ReceiptVerification,
  type SmtpTranscriptLine,
  type SuppressionEntry,
  type VariableValues,
} from "@sealpost/core";
import { loadOrCreateLocalKeys, type LocalKeys } from "./keyVault";
import { createPersistedStore } from "./persisted";
import { api } from "./serverApi";

export interface PreviewRequest {
  template: EmailTemplate;
  domain: DomainProfile;
  to: string;
  variables: VariableValues;
  includeMime: boolean;
}

export interface PreviewView {
  preflight: PreflightResult;
  rawMime?: string;
  dkim?: DkimVerification;
}

export type SendStatus = "delivered" | "queued" | "failed" | "blocked";

export interface SendView {
  status: SendStatus;
  preflight: PreflightResult;
  messageId?: string;
  rawMime?: string;
  receiptToken?: string;
  receiptId?: string;
  ledgerSeq?: number;
  transcript: SmtpTranscriptLine[] | null;
  smtp?: { host: string; port: number; finalResponse: string; failedOver?: boolean; mailboxId?: string };
  error?: string;
  suppressed?: string[];
  /** Captured by the browser, not delivered over a network. */
  simulated?: boolean;
}

export interface InboxItem {
  id: string;
  receivedAtIso: string;
  mailFrom: string;
  rcptTo: string[];
  subject: string;
  from: string;
  to: string;
  messageId: string;
  size: number;
  dkim: DkimVerification | null;
}

export interface MailClient {
  mode: "server" | "local";
  receiptFingerprint: string;
  keyPersistent: boolean;
  dkimPublicKeyJwk: JsonWebKey;
  preview(r: PreviewRequest): Promise<PreviewView>;
  send(templateId: string, template: EmailTemplate, domain: DomainProfile, to: string, variables: VariableValues): Promise<SendView>;
  inbox(): Promise<InboxItem[]>;
  inboxMessage(id: string): Promise<{ meta: InboxItem; raw: string } | null>;
  clearInbox(): Promise<void>;
  suppressions(): Promise<SuppressionEntry[]>;
  suppress(email: string, reason: SuppressionEntry["reason"]): Promise<SuppressionEntry[]>;
  unsuppress(email: string): Promise<SuppressionEntry[]>;
  ledger(): Promise<DeliveryLedgerRecord[]>;
  verifyLedger(): Promise<LedgerVerification>;
  verifyReceipt(token: string, inboxId?: string): Promise<ReceiptVerification>;
  dns(domain: DomainProfile): Promise<DnsRecord[]>;
  clearLedger?(): void;
}

/* ───────────────────────── server mode ───────────────────────── */

interface ServerSend {
  status: SendStatus;
  preflight: PreflightResult;
  messageId?: string;
  rawMime?: string;
  receipt?: { token: string; receiptId: string };
  record?: { seq: number };
  smtp?: { host: string; port: number; finalResponse: string; transcript: SmtpTranscriptLine[]; failedOver?: boolean; mailboxId?: string };
  error?: string;
  suppressed?: string[];
}

function fromServer(o: ServerSend): SendView {
  return { status: o.status, preflight: o.preflight, messageId: o.messageId, rawMime: o.rawMime, receiptToken: o.receipt?.token, receiptId: o.receipt?.receiptId, ledgerSeq: o.record?.seq, transcript: o.smtp?.transcript ?? null, smtp: o.smtp && { host: o.smtp.host, port: o.smtp.port, finalResponse: o.smtp.finalResponse, failedOver: o.smtp.failedOver, mailboxId: o.smtp.mailboxId }, error: o.error, suppressed: o.suppressed };
}

export function serverClient(info: { keyFingerprint: string }, dkimPublicKeyJwk: JsonWebKey): MailClient {
  return {
    mode: "server",
    receiptFingerprint: info.keyFingerprint,
    keyPersistent: true,
    dkimPublicKeyJwk,
    preview: async (r) => {
      const res = await api<{ preflight: PreflightResult; rawMime?: string; dkim?: DkimVerification }>("/api/compile", { method: "POST", body: { template: r.template, to: r.to, variables: r.variables, includeMime: r.includeMime } });
      return { preflight: res.preflight, rawMime: res.rawMime, dkim: res.dkim };
    },
    send: async (templateId, _t, _d, to, variables) => {
      try {
        return fromServer(await api<ServerSend>("/api/send", { method: "POST", body: { templateId, to, variables } }));
      } catch (e) {
        const body = (e as { body?: ServerSend }).body;
        if (body && body.preflight) return fromServer(body);
        throw e;
      }
    },
    inbox: async () => (await api<{ messages: InboxItem[] }>("/api/inbox")).messages,
    inboxMessage: async (id) => {
      try {
        const r = await api<{ meta: InboxItem; raw: string }>(`/api/inbox/${id}`);
        return { meta: r.meta, raw: r.raw };
      } catch {
        return null;
      }
    },
    clearInbox: async () => void (await api("/api/inbox", { method: "DELETE" })),
    suppressions: async () => (await api<{ suppressions: SuppressionEntry[] }>("/api/suppressions")).suppressions,
    suppress: async (email, reason) => (await api<{ suppressions: SuppressionEntry[] }>("/api/suppressions", { method: "POST", body: { email, reason } })).suppressions,
    unsuppress: async (email) => (await api<{ suppressions: SuppressionEntry[] }>(`/api/suppressions?email=${encodeURIComponent(email)}`, { method: "DELETE" })).suppressions,
    ledger: async () => (await api<{ records: DeliveryLedgerRecord[] }>("/api/ledger")).records,
    verifyLedger: () => api("/api/ledger/verify"),
    verifyReceipt: (token, inboxId) => api("/api/verify", { method: "POST", body: { token, inboxId } }),
    dns: async () => (await api<{ records: DnsRecord[] }>("/api/dns")).records,
  };
}

/* ───────────────────────── local demo mode ───────────────────────── */

interface LocalState {
  ledger: DeliveryLedgerRecord[]; // oldest first
  inbox: Array<InboxItem & { raw: string }>;
  suppressions: SuppressionEntry[];
}
export const localStore = createPersistedStore<LocalState>("sealpost-local", { ledger: [], inbox: [], suppressions: [] });
const DEDUPE_MS = 24 * 3_600_000;

/** Compile, pre-flight, MIME, DKIM and receipts all run in this browser. There is no SMTP socket: delivery is captured locally. */
export async function localClient(): Promise<MailClient> {
  const keys: LocalKeys = await loadOrCreateLocalKeys();
  const registry = await buildRegistry([keys.receipt.publicKeyJwk]);
  const recent = (): Set<string> => new Set(localStore.getSnapshot().ledger.filter((r) => Date.now() - Date.parse(r.timestampIso) <= DEDUPE_MS).map((r) => r.idempotencyKey));
  const state = (): LocalState => localStore.getSnapshot();

  const run = async (template: EmailTemplate, domain: DomainProfile, to: string, variables: VariableValues, messageId: string): Promise<PreflightResult> =>
    evaluateDispatchPreflight({ to, variables }, { template, domain, suppressions: state().suppressions, recentKeys: recent(), compile: domain.trackingBaseUrl ? { tracking: { baseUrl: domain.trackingBaseUrl, messageId } } : undefined });

  return {
    mode: "local",
    receiptFingerprint: keys.receipt.fingerprint,
    keyPersistent: keys.persistent,
    dkimPublicKeyJwk: keys.dkim.publicKeyJwk,
    preview: async (r) => {
      const messageId = newMessageId(r.domain.domain);
      const preflight = await run(r.template, r.domain, r.to, r.variables, messageId);
      if (!r.includeMime || preflight.checks.some((c) => c.code === "EW-102" && c.severity === "block")) return { preflight };
      const signed = await composeSignedMessage({ preflight, domain: r.domain, messageId, privateKey: keys.dkim.privateKey });
      return { preflight, rawMime: signed.raw, dkim: await verifyDkimSignature(signed.raw, keys.dkim.publicKeyJwk) };
    },
    send: async (_id, template, d, to, variables) => {
      const messageId = newMessageId(d.domain);
      const preflight = await run(template, d, to, autoFillSampleVariables(template, variables), messageId);
      if (preflight.gate === "BLOCKED") return { status: "blocked", preflight, messageId, transcript: null };
      const signed = await composeSignedMessage({ preflight, domain: d, messageId, privateKey: keys.dkim.privateKey });
      const mimeSha256 = await sha256OfMime(signed.raw);
      const receipt = await generateDeliveryReceipt({ templateId: template.id, templateVersion: template.version, to: preflight.recipients.to.join(", "), fromEmail: preflight.recipients.fromEmail, subject: preflight.compiled.subject, messageId, mimeSha256, dkimBodyHash: signed.bodyHash, idempotencyKey: preflight.idempotencyKey, smtpHost: "browser-local-capture", smtpStatusCode: 250, smtpBanner: "220 browser local capture (no network)", smtpQueuedResponse: "250 2.0.0 Ok: captured locally", deliverabilityScore: preflight.score }, keys.receipt);
      const record = await buildLedgerRecord(state().ledger.at(-1), receipt);
      const dkim = await verifyDkimSignature(signed.raw, keys.dkim.publicKeyJwk);
      const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
      const item: InboxItem & { raw: string } = { id, receivedAtIso: new Date().toISOString(), mailFrom: preflight.recipients.fromEmail, rcptTo: preflight.recipients.to, subject: preflight.compiled.subject, from: preflight.recipients.fromEmail, to: preflight.recipients.to.join(", "), messageId, size: signed.raw.length, dkim, raw: signed.raw };
      localStore.set({ ...state(), ledger: [...state().ledger, record], inbox: [item, ...state().inbox] });
      return { status: "delivered", preflight, messageId, rawMime: signed.raw, receiptToken: receipt.token, receiptId: receipt.receiptId, ledgerSeq: record.seq, transcript: [], smtp: { host: "browser-local-capture", port: 0, finalResponse: "250 2.0.0 Ok: captured locally" }, simulated: true };
    },
    inbox: async () =>
      state().inbox.map((m) => {
        const { raw, ...meta } = m;
        void raw;
        return meta;
      }),
    inboxMessage: async (id) => {
      const m = state().inbox.find((x) => x.id === id);
      if (!m) return null;
      const { raw, ...meta } = m;
      return { meta, raw };
    },
    clearInbox: async () => localStore.set({ ...state(), inbox: [] }),
    suppressions: async () => state().suppressions,
    suppress: async (email, reason) => {
      const next = addSuppression(state().suppressions, { email, reason, atIso: new Date().toISOString() });
      localStore.set({ ...state(), suppressions: next });
      return next;
    },
    unsuppress: async (email) => {
      const next = removeSuppression(state().suppressions, email);
      localStore.set({ ...state(), suppressions: next });
      return next;
    },
    ledger: async () => [...state().ledger].reverse(),
    verifyLedger: () => verifyDeliveryLedger(state().ledger),
    verifyReceipt: async (token, inboxId) => verifyDeliveryReceipt(token, { issuerRegistry: registry, rawMime: inboxId ? state().inbox.find((m) => m.id === inboxId)?.raw : undefined }),
    dns: async (domain) => synthesizeDnsRecords(domain, keys.dkim.publicKeySpkiBase64),
    clearLedger: () => localStore.set({ ...state(), ledger: [] }),
  };
}
