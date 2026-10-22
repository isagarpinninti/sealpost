export type SuppressionReason = "hard_bounce" | "unsubscribed" | "complaint";

export interface SuppressionEntry {
  email: string;
  reason: SuppressionReason;
  atIso: string;
  detail?: string;
}

export const normalizeEmail = (e: string): string => e.trim().toLowerCase();

export function isSuppressed(list: readonly SuppressionEntry[], email: string): SuppressionEntry | undefined {
  const n = normalizeEmail(email);
  return list.find((s) => normalizeEmail(s.email) === n);
}

/** Adds an entry (the earliest reason is kept, so a bounce is never overwritten by a later event). */
export function addSuppression(list: readonly SuppressionEntry[], entry: SuppressionEntry): SuppressionEntry[] {
  return isSuppressed(list, entry.email) ? [...list] : [...list, { ...entry, email: normalizeEmail(entry.email) }];
}

export function removeSuppression(list: readonly SuppressionEntry[], email: string): SuppressionEntry[] {
  const n = normalizeEmail(email);
  return list.filter((s) => normalizeEmail(s.email) !== n);
}

export type RecipientOutcome = "accepted" | "hard_bounce" | "soft_bounce" | "rejected_policy";

/**
 * Classifies the SMTP reply to `RCPT TO` (or to the DATA terminator).
 * 550/551/553/554 mean the mailbox is bad: suppress it. 552 (mailbox full) and every 4xx are retryable.
 * 530/535 are about *our* credentials, not the recipient, so they never suppress anyone.
 */
export function classifyRecipientReply(code: number): RecipientOutcome {
  if (code >= 200 && code < 300) return "accepted";
  if (code >= 400 && code < 500) return "soft_bounce";
  if (code === 552 || code === 452) return "soft_bounce";
  if (code === 530 || code === 535 || code === 534 || code === 538) return "rejected_policy";
  if (code >= 500 && code < 600) return "hard_bounce";
  return "soft_bounce";
}

/** Retry schedule for transient failures: 10 s → 1 min → 5 min, then give up. */
export const RETRY_DELAYS_MS: readonly number[] = [10_000, 60_000, 300_000];

/** Delay before retry number `attempt` (1-based), or `null` when the schedule is exhausted. */
export function retryDelayMs(attempt: number): number | null {
  return attempt >= 1 && attempt <= RETRY_DELAYS_MS.length ? RETRY_DELAYS_MS[attempt - 1] : null;
}
