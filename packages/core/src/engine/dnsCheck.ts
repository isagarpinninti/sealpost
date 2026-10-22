import type { DnsRecord } from "../crypto/dkim";

export interface DnsCheckResult {
  purpose: DnsRecord["purpose"];
  fqdn: string;
  status: "ok" | "missing" | "mismatch" | "skipped";
  detail: string;
  found: string[];
}

/** Resolves MX records for a name. Reject (or return []) when there are none. */
export type MxResolver = (fqdn: string) => Promise<Array<{ exchange: string; priority: number }>>;

/** Resolves TXT records for a name. Each record arrives as the chunks DNS split it into. Reject (or return []) when the name does not exist. */
export type TxtResolver = (fqdn: string) => Promise<string[][]>;

const joined = (rows: string[][]): string[] => rows.map((r) => r.join(""));
const squash = (s: string): string => s.replace(/\s+/g, "");

/** Compares the records Sealpost says to publish with what DNS actually returns. MX is optional and reported as skipped. */
export async function checkDnsRecords(records: readonly DnsRecord[], resolveTxt: TxtResolver, opts: { spfInclude?: string; resolveMx?: MxResolver; expectMxHost?: string } = {}): Promise<DnsCheckResult[]> {
  const out: DnsCheckResult[] = [];
  for (const rec of records) {
    if (rec.type !== "TXT") {
      if (!opts.resolveMx) {
        out.push({ purpose: rec.purpose, fqdn: rec.fqdn, status: "skipped", detail: "Only needed if this domain receives mail.", found: [] });
        continue;
      }
      let mx: Array<{ exchange: string; priority: number }> = [];
      try {
        mx = await opts.resolveMx(rec.fqdn);
      } catch {
        mx = [];
      }
      const found = mx.sort((a, b) => a.priority - b.priority).map((m) => `${m.priority} ${m.exchange}`);
      const norm = (h: string): string => h.toLowerCase().replace(/\.$/, "");
      if (mx.length === 0) out.push({ purpose: rec.purpose, fqdn: rec.fqdn, status: "missing", detail: "No MX record found: senders cannot deliver mail to this domain.", found });
      else if (opts.expectMxHost && !mx.some((m) => norm(m.exchange) === norm(opts.expectMxHost ?? ""))) out.push({ purpose: rec.purpose, fqdn: rec.fqdn, status: "mismatch", detail: `MX points to ${found.join(", ")} but inbound.mxHost is ${opts.expectMxHost}.`, found });
      else out.push({ purpose: rec.purpose, fqdn: rec.fqdn, status: "ok", detail: "MX record present.", found });
      continue;
    }
    let found: string[] = [];
    try {
      found = joined(await resolveTxt(rec.fqdn));
    } catch {
      found = [];
    }
    const base = { purpose: rec.purpose, fqdn: rec.fqdn, found };
    if (rec.purpose === "SPF") {
      const spf = found.filter((v) => /^v=spf1\b/i.test(v));
      if (spf.length === 0) out.push({ ...base, status: "missing", detail: "No SPF record found." });
      else if (spf.length > 1) out.push({ ...base, status: "mismatch", detail: "More than one SPF record: receivers treat that as a permanent error. Merge them into one." });
      else if (opts.spfInclude && !spf[0].toLowerCase().includes(`include:${opts.spfInclude.toLowerCase()}`)) out.push({ ...base, status: "mismatch", detail: `SPF does not include ${opts.spfInclude}.` });
      else out.push({ ...base, status: "ok", detail: "SPF record present." });
    } else if (rec.purpose === "DKIM") {
      const want = /p=([^;\s]+)/.exec(squash(rec.value))?.[1] ?? "";
      const have = found.map((v) => /p=([^;\s]+)/.exec(squash(v))?.[1]).find((p) => p !== undefined);
      if (found.length === 0) out.push({ ...base, status: "missing", detail: "No DKIM record at this selector." });
      else if (have !== want) out.push({ ...base, status: "mismatch", detail: "The published public key differs from Sealpost's key (stale selector or truncated value)." });
      else out.push({ ...base, status: "ok", detail: "Published key matches." });
    } else {
      if (!found.some((v) => /^v=DMARC1\b/i.test(v))) out.push({ ...base, status: "missing", detail: "No DMARC record found." });
      else out.push({ ...base, status: "ok", detail: "DMARC record present." });
    }
  }
  return out;
}
