/** Normalised delivery feedback from an upstream SMTP relay (SES, SendGrid, Postmark, Mailgun). */
export type RelayProvider = "ses" | "sendgrid" | "postmark" | "mailgun";
export const RELAY_PROVIDERS: readonly RelayProvider[] = ["ses", "sendgrid", "postmark", "mailgun"];

export type RelayEventKind = "delivered" | "hard_bounce" | "soft_bounce" | "complaint";

export interface RelayEvent {
  kind: RelayEventKind;
  email: string;
  detail?: string;
  relayMessageId?: string;
}

export interface RelayParseResult {
  events: RelayEvent[];
  /** SNS asks the endpoint owner to confirm the subscription by visiting this URL. It is never fetched automatically. */
  confirmationUrl?: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const clip = (s: string | undefined): string | undefined => (s === undefined ? undefined : s.slice(0, 300));

function event(kind: RelayEventKind, email: string | undefined, detail?: string, relayMessageId?: string): RelayEvent[] {
  return email ? [{ kind, email: email.toLowerCase(), detail: clip(detail), relayMessageId }] : [];
}

function parseSes(body: unknown): RelayParseResult {
  if (!isObj(body)) return { events: [] };
  if (body.Type === "SubscriptionConfirmation") {
    const url = str(body.SubscribeURL);
    return { events: [], confirmationUrl: url && /^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?\//i.test(url) ? url : undefined };
  }
  let message: unknown = body;
  if (body.Type === "Notification" && typeof body.Message === "string") {
    try {
      message = JSON.parse(body.Message);
    } catch {
      return { events: [] };
    }
  }
  if (!isObj(message)) return { events: [] };
  const type = str(message.notificationType) ?? str(message.eventType);
  const mail = isObj(message.mail) ? message.mail : {};
  const id = str(mail.messageId);
  if (type === "Bounce" && isObj(message.bounce)) {
    const hard = message.bounce.bounceType === "Permanent";
    return { events: arr(message.bounce.bouncedRecipients).flatMap((r) => (isObj(r) ? event(hard ? "hard_bounce" : "soft_bounce", str(r.emailAddress), str(r.diagnosticCode) ?? str(message.bounce && (message.bounce as Obj).bounceSubType), id) : [])) };
  }
  if (type === "Complaint" && isObj(message.complaint)) {
    return { events: arr(message.complaint.complainedRecipients).flatMap((r) => (isObj(r) ? event("complaint", str(r.emailAddress), str((message.complaint as Obj).complaintFeedbackType), id) : [])) };
  }
  if (type === "Delivery" && isObj(message.delivery)) {
    return { events: arr(message.delivery.recipients).flatMap((r) => event("delivered", str(r), undefined, id)) };
  }
  return { events: [] };
}

function parseSendgrid(body: unknown): RelayParseResult {
  return {
    events: arr(body).flatMap((e) => {
      if (!isObj(e)) return [];
      const email = str(e.email);
      const id = str(e.sg_message_id);
      const reason = str(e.reason) ?? str(e.response);
      switch (e.event) {
        case "delivered":
          return event("delivered", email, undefined, id);
        case "bounce":
          return event(e.type === "blocked" ? "soft_bounce" : "hard_bounce", email, reason, id);
        case "dropped":
          return event("hard_bounce", email, reason, id);
        case "deferred":
          return event("soft_bounce", email, reason, id);
        case "spamreport":
          return event("complaint", email, undefined, id);
        default:
          return [];
      }
    }),
  };
}

function parsePostmark(body: unknown): RelayParseResult {
  const items = Array.isArray(body) ? body : [body];
  return {
    events: items.flatMap((e) => {
      if (!isObj(e)) return [];
      const id = str(e.MessageID);
      switch (e.RecordType) {
        case "Delivery":
          return event("delivered", str(e.Recipient), undefined, id);
        case "SpamComplaint":
          return event("complaint", str(e.Email), str(e.Details), id);
        case "Bounce": {
          const hard = e.Type === "HardBounce" || e.Type === "BadEmailAddress" || e.Type === "ManuallyDeactivated";
          return event(hard ? "hard_bounce" : "soft_bounce", str(e.Email), str(e.Details), id);
        }
        default:
          return [];
      }
    }),
  };
}

function parseMailgun(body: unknown): RelayParseResult {
  if (!isObj(body) || !isObj(body["event-data"])) return { events: [] };
  const d = body["event-data"];
  const email = str(d.recipient);
  const message = isObj(d.message) && isObj(d.message.headers) ? str(d.message.headers["message-id"]) : undefined;
  const status = isObj(d["delivery-status"]) ? (str(d["delivery-status"].message) ?? str(d["delivery-status"].description)) : undefined;
  switch (d.event) {
    case "delivered":
      return { events: event("delivered", email, undefined, message) };
    case "failed":
      return { events: event(d.severity === "permanent" ? "hard_bounce" : "soft_bounce", email, status, message) };
    case "complained":
      return { events: event("complaint", email, undefined, message) };
    default:
      return { events: [] };
  }
}

/** Parses an already JSON-decoded webhook body. Unknown shapes yield no events rather than throwing. */
export function parseRelayEvents(provider: RelayProvider, body: unknown): RelayParseResult {
  switch (provider) {
    case "ses":
      return parseSes(body);
    case "sendgrid":
      return parseSendgrid(body);
    case "postmark":
      return parsePostmark(body);
    case "mailgun":
      return parseMailgun(body);
  }
}
