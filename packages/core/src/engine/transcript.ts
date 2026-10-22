/** One line of an RFC 5321 session: `S` server, `C` client, `I` informational (TLS upgrade, connect, failover). */
export interface SmtpTranscriptLine {
  /** Milliseconds since the connection attempt began. */
  atMs: number;
  dir: "S" | "C" | "I";
  text: string;
}

export interface SmtpDispatchResult {
  ok: boolean;
  host: string;
  port: number;
  banner: string;
  /** The server's reply to the end of DATA, e.g. `250 2.0.0 Ok: queued as 4F2A`. */
  finalResponse: string;
  finalCode: number;
  accepted: string[];
  rejected: Array<{ recipient: string; code: number; message: string }>;
  transcript: SmtpTranscriptLine[];
  /** Transient failure: safe to retry later. */
  retryable: boolean;
  /** The relay refused our credentials (530/535): another relay may still work, and nobody gets suppressed. */
  authFailed?: boolean;
  /** Which configured mailbox carried (or last tried) the message. */
  mailboxId?: string;
  /** The primary relay failed and a backup was used. */
  failedOver?: boolean;
  error?: string;
}
