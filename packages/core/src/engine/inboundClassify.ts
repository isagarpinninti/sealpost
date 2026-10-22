import { parseParams, type ParsedMessage } from "./mimeParse";

export type InboundKind = "message" | "bounce" | "complaint";

export interface BounceRecipient {
  email: string;
  /** Enhanced status code, e.g. `5.1.1`. */
  status?: string;
  action: "failed" | "delayed" | "delivered" | "relayed" | "expanded" | "unknown";
  diagnostic?: string;
  /** A permanent failure: `Action: failed` with a 5.x.x status. */
  hard: boolean;
}

export interface InboundClassification {
  kind: InboundKind;
  /** Automatic reply (out-of-office, vacation, auto-generated): do not answer it. */
  autoReply: boolean;
  bounce?: {
    recipients: BounceRecipient[];
    /** Message-ID of the message that bounced, when the report quotes it. */
    originalMessageId?: string;
    /** True when it looks like a bounce but carries no machine-readable report. */
    unparsed: boolean;
  };
  complaint?: { recipient?: string; feedbackType?: string; originalMessageId?: string };
}

const text = (m: ParsedMessage, type: string): string | undefined => {
  const a = m.attachments.find((x) => x.contentType === type);
  return a ? new TextDecoder("utf-8").decode(a.content) : undefined;
};

/** `Key: value` lines of one block, folded lines joined, keys lower-cased. */
function fields(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  let key = "";
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && key) out[key] += ` ${line.trim()}`;
    else {
      const i = line.indexOf(":");
      if (i > 0) {
        key = line.slice(0, i).trim().toLowerCase();
        out[key] = line.slice(i + 1).trim();
      }
    }
  }
  return out;
}

const address = (v: string | undefined): string | undefined => {
  if (!v) return undefined;
  const m = /([^\s<>;,()"]+@[^\s<>;,()"]+)/.exec(v.replace(/^[a-z0-9-]+;\s*/i, ""));
  return m?.[1].toLowerCase();
};

const originalId = (m: ParsedMessage): string | undefined => {
  for (const type of ["message/rfc822", "text/rfc822-headers"]) {
    const body = text(m, type);
    const id = body ? /^message-id:\s*<([^<>\s]+)>/im.exec(body)?.[1] : undefined;
    if (id) return id;
  }
  return undefined;
};

const header = (m: ParsedMessage, name: string): string => m.headers.find((h) => h.name.toLowerCase() === name)?.value ?? "";

/**
 * Tells a person's message apart from a delivery report (RFC 3464), an abuse report (ARF, RFC 5965) and an
 * automatic reply (RFC 3834). Reports are only ever trusted by the caller after matching `originalMessageId`
 * to mail it actually sent, so a forged report cannot suppress an arbitrary address.
 */
export function classifyInbound(m: ParsedMessage): InboundClassification {
  const submitted = header(m, "auto-submitted").trim().toLowerCase();
  const autoReply = (submitted !== "" && submitted !== "no") || /^auto[_-]?reply$/i.test(header(m, "precedence").trim()) || header(m, "x-autoreply") !== "" || header(m, "x-autorespond") !== "";
  const ct = parseParams(m.headers.find((h) => h.name.toLowerCase() === "content-type")?.raw ?? "");

  if (ct.main === "multipart/report") {
    const kind = (ct.params["report-type"] ?? "").toLowerCase();
    if (kind === "delivery-status") {
      const status = text(m, "message/delivery-status") ?? "";
      const groups = status.split(/\r?\n\r?\n/).filter((g) => g.trim() !== "");
      const recipients: BounceRecipient[] = [];
      for (const g of groups.slice(1)) {
        const f = fields(g);
        const email = address(f["final-recipient"] ?? f["original-recipient"]);
        if (!email) continue;
        const action = (f.action ?? "").toLowerCase();
        const known = ["failed", "delayed", "delivered", "relayed", "expanded"] as const;
        const act: BounceRecipient["action"] = (known as readonly string[]).includes(action) ? (action as BounceRecipient["action"]) : "unknown";
        const code = /\b([245]\.\d{1,3}\.\d{1,3})\b/.exec(f.status ?? "")?.[1];
        recipients.push({ email, status: code, action: act, diagnostic: f["diagnostic-code"]?.replace(/^smtp;\s*/i, "").slice(0, 300), hard: act === "failed" && (code?.startsWith("5.") ?? false) });
      }
      return { kind: "bounce", autoReply: false, bounce: { recipients, originalMessageId: originalId(m), unparsed: recipients.length === 0 } };
    }
    if (kind === "feedback-report") {
      const f = fields(text(m, "message/feedback-report") ?? "");
      const orig = text(m, "message/rfc822") ?? text(m, "text/rfc822-headers") ?? "";
      return { kind: "complaint", autoReply: false, complaint: { recipient: address(f["original-rcpt-to"] ?? f["removal-recipient"]) ?? address(/^to:\s*(.+)$/im.exec(orig)?.[1]), feedbackType: f["feedback-type"]?.toLowerCase(), originalMessageId: originalId(m) } };
    }
  }

  const from = (m.from?.address ?? "").toLowerCase();
  if (/^(mailer-daemon|postmaster)@/.test(from) && /undeliver|delivery (status|failure)|returned mail|failure notice|could not be delivered/i.test(m.subject)) {
    return { kind: "bounce", autoReply: false, bounce: { recipients: [], originalMessageId: originalId(m), unparsed: true } };
  }
  return { kind: "message", autoReply };
}
