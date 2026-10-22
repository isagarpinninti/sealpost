import { parseHeaders, splitMime } from "./mime";

export type AuthVerdict = "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror" | "policy" | "unknown";

export interface AuthMethodResult {
  method: "dkim" | "spf" | "dmarc";
  verdict: AuthVerdict;
  /** The text after the verdict: `header.d=…`, `smtp.mailfrom=…`, the policy, and so on. */
  detail: string;
  /** The receiver that wrote this result. */
  receiver: string;
}

export interface AuthReport {
  /** True when DKIM, SPF and DMARC all report `pass`. */
  ok: boolean;
  fromDomain?: string;
  /** `d=` of every DKIM-Signature header carried by the message. */
  signedDomains: string[];
  results: AuthMethodResult[];
  /** Plain-language reasons the message is not fully authenticated. */
  problems: string[];
}

const VERDICTS: readonly AuthVerdict[] = ["pass", "fail", "softfail", "neutral", "none", "temperror", "permerror", "policy"];
const METHOD = /\b(dkim|spf|dmarc)=([a-z]+)([^;]*)/gi;

/**
 * Reads the `Authentication-Results` headers a receiving mailbox (Gmail, Outlook, Yahoo…) stamped on a message
 * and reports whether DKIM, SPF and DMARC passed. Use it on the "original" / "raw" message you download from the
 * inbox that received a test send.
 */
export function analyzeAuthenticationResults(rawMessage: string): AuthReport {
  const normalised = rawMessage.replace(/\r?\n/g, "\r\n");
  const headers = parseHeaders(splitMime(normalised).headerBlock);
  const results: AuthMethodResult[] = [];
  for (const h of headers) {
    if (h.name.toLowerCase() !== "authentication-results") continue;
    const receiver = h.value.split(";")[0].trim();
    for (const m of h.value.matchAll(METHOD)) {
      const verdict = (VERDICTS as readonly string[]).includes(m[2].toLowerCase()) ? (m[2].toLowerCase() as AuthVerdict) : "unknown";
      results.push({ method: m[1].toLowerCase() as AuthMethodResult["method"], verdict, detail: m[3].trim(), receiver });
    }
  }
  const from = headers.find((h) => h.name.toLowerCase() === "from")?.value ?? "";
  const fromDomain = /@([A-Za-z0-9.-]+)>?\s*$/.exec(from)?.[1]?.toLowerCase();
  const signedDomains = headers
    .filter((h) => h.name.toLowerCase() === "dkim-signature")
    .map((h) => /(?:^|;)\s*d=([^;\s]+)/i.exec(h.value)?.[1]?.toLowerCase())
    .filter((d): d is string => d !== undefined);

  const problems: string[] = [];
  const verdictOf = (m: AuthMethodResult["method"]): AuthVerdict | undefined => results.find((r) => r.method === m)?.verdict;
  if (results.length === 0) problems.push("No Authentication-Results header. Download the original message from the receiving inbox (Gmail: ⋮ → Show original → Download original), not a forwarded copy.");
  if (signedDomains.length === 0) problems.push("The message carries no DKIM-Signature header.");
  else if (fromDomain && !signedDomains.some((d) => fromDomain === d || fromDomain.endsWith(`.${d}`))) problems.push(`DKIM is signed for ${signedDomains.join(", ")} but the From domain is ${fromDomain}: DMARC alignment fails.`);
  for (const m of ["dkim", "spf", "dmarc"] as const) {
    const v = verdictOf(m);
    if (results.length > 0 && v === undefined) problems.push(`The receiver did not report ${m.toUpperCase()}.`);
    else if (v !== undefined && v !== "pass") problems.push(`${m.toUpperCase()} is ${v}${m === "dkim" ? ": check the DKIM TXT record at <selector>._domainkey and that the key matches" : m === "spf" ? ": your relay must be authorised in the SPF record (spfInclude)" : ": DMARC needs DKIM or SPF to pass and align with the From domain"}.`);
  }
  return { ok: results.length > 0 && (["dkim", "spf", "dmarc"] as const).every((m) => verdictOf(m) === "pass"), fromDomain, signedDomains, results, problems };
}
