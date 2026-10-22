import { parseParams, parseHeaders } from "@sealpost/core";

/**
 * Pulls the raw RFC 5322 message out of what a relay's inbound webhook posts:
 *   - `message/rfc822`, `text/plain` or `application/octet-stream`: the body is the message;
 *   - `application/json`: `{ raw }`, `{ rawBase64 }`, or an SES→SNS notification whose Message has `content`;
 *   - `multipart/form-data`: the `email` field (SendGrid "send raw") or `body-mime` (Mailgun).
 * Returns null when no message can be found.
 */
export function extractRawMessage(contentType: string | undefined, body: Buffer): Buffer | null {
  const ct = parseParams(contentType ?? "");
  if (ct.main === "application/json") {
    let json: unknown;
    try {
      json = JSON.parse(body.toString("utf8"));
    } catch {
      return null;
    }
    const o = json as Record<string, unknown>;
    if (typeof o?.raw === "string") return Buffer.from(o.raw, "utf8");
    if (typeof o?.rawBase64 === "string") return Buffer.from(o.rawBase64, "base64");
    if (o?.Type === "Notification" && typeof o.Message === "string") {
      try {
        const msg = JSON.parse(o.Message) as { content?: unknown };
        if (typeof msg.content === "string") return Buffer.from(msg.content, "utf8");
      } catch {
        return null;
      }
    }
    return null;
  }
  if (ct.main === "multipart/form-data") {
    const boundary = ct.params.boundary;
    if (!boundary) return null;
    const text = body.toString("latin1");
    const delim = `--${boundary}`;
    for (const chunk of text.split(delim).slice(1)) {
      if (chunk.startsWith("--")) break;
      const part = chunk.replace(/^\r?\n/, "");
      const m = /\r?\n\r?\n/.exec(part);
      if (!m) continue;
      const headers = parseHeaders(part.slice(0, m.index).replace(/\r?\n/g, "\r\n"));
      const disposition = headers.find((h) => h.name.toLowerCase() === "content-disposition")?.value ?? "";
      const name = parseParams(disposition).params.name;
      if (name === "email" || name === "body-mime") return Buffer.from(part.slice(m.index + m[0].length).replace(/\r?\n$/, ""), "latin1");
    }
    return null;
  }
  return body.length > 0 ? body : null;
}
