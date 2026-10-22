import { createHmac, timingSafeEqual } from "node:crypto";
import type { DomainProfile } from "@sealpost/core";
import type { Runtime } from "./runtime";

/**
 * Hosted unsubscribe. The link carries the recipient, the domain and the email it came from, signed with a server
 * secret, so it cannot be forged or pointed at another address. It never expires: an unsubscribe link must keep working.
 */
export interface UnsubClaims {
  /** Recipient. */
  e: string;
  /** Sending domain. */
  d: string;
  /** The `em_…` it was minted for (optional). */
  i?: string;
}

const sign = (secret: Buffer, payload: string): string => createHmac("sha256", secret).update(`u1.${payload}`).digest("base64url");

export function createUnsubToken(secret: Buffer, claims: UnsubClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${sign(secret, payload)}`;
}

export function verifyUnsubToken(secret: Buffer, token: string): UnsubClaims | null {
  const [payload, mac, extra] = token.split(".");
  if (!payload || !mac || extra !== undefined || token.length > 1000) return null;
  const want = Buffer.from(sign(secret, payload));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const c = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as UnsubClaims;
    return typeof c.e === "string" && typeof c.d === "string" && (c.i === undefined || typeof c.i === "string") ? c : null;
  } catch {
    return null;
  }
}

/** The hosted URL for `email`, or undefined when hosted unsubscribe is off or the domain has no public tracking URL. */
export function hostedUnsubUrl(rt: Runtime, profile: DomainProfile, email: string, emailId?: string): string | undefined {
  if (!rt.project.config.unsubscribe.hosted || !profile.trackingBaseUrl || !email.includes("@")) return undefined;
  return `${profile.trackingBaseUrl.replace(/\/$/, "")}/u/${createUnsubToken(rt.secret, { e: email.trim().toLowerCase(), d: profile.domain, i: emailId })}`;
}

/** The domain profile with its unsubscribe link replaced by the recipient's hosted one, when enabled. */
export function withHostedUnsub(rt: Runtime, profile: DomainProfile, to: string | string[], emailId?: string): DomainProfile {
  const first = (Array.isArray(to) ? to[0] : to)?.split(",")[0] ?? "";
  const url = hostedUnsubUrl(rt, profile, first, emailId);
  return url ? { ...profile, unsubscribeUrl: url } : profile;
}
