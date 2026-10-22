type Json = Record<string, unknown>;

const bearer = [{ bearerAuth: [] }];
const ok = (description: string, schema: Json = { type: "object" }): Json => ({ description, content: { "application/json": { schema } } });
const body = (schema: Json): Json => ({ required: true, content: { "application/json": { schema } } });
const err = (description: string): Json => ({ description, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } });

/** OpenAPI 3.1 description of the REST API served by `sealpost studio`. */
export function buildOpenApi(version: string): Json {
  return {
    openapi: "3.1.0",
    info: { title: "Sealpost API", version, description: "Self-hosted email API: compile, gate, DKIM-sign, send over SMTP and verify receipts. Authenticate with `Authorization: Bearer evk_…` (or the master SEALPOST_API_KEY)." },
    servers: [{ url: "http://127.0.0.1:4320" }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: {
        Error: { type: "object", description: "Every error has a stable machine-readable `code`: invalid_request, unauthorized, forbidden, not_found, conflict, idempotency_key_reuse, payload_too_large, validation_error, rate_limited, preflight_blocked, smtp_failed, internal_error. `requestId` matches the x-request-id response header.", properties: { ok: { const: false }, error: { type: "string" }, code: { type: "string" }, requestId: { type: "string" } }, required: ["ok", "error", "code"] },
        SendRequest: {
          type: "object",
          required: ["templateId", "to"],
          properties: {
            templateId: { type: "string" },
            domain: { type: "string", description: "One of the configured sending domains; defaults to the primary." },
            scheduledAt: { type: "string", format: "date-time", description: "Send later, up to 90 days ahead. The gate runs now (a bad request is refused immediately) and again at that time. Responds 202 with status `scheduled` and an `sch_…` id." },
            inReplyTo: { type: "string", description: "Send as a reply: a Message-ID, or the `in_…` id of a received message. Adds In-Reply-To and References (signed by DKIM)." },
            tags: { type: "array", maxItems: 10, description: "Labels to filter logs by.", items: { type: "object", required: ["name", "value"], properties: { name: { type: "string" }, value: { type: "string" } } } },
            metadata: { type: "object", additionalProperties: { type: "string" }, description: "Up to 20 keys of your own data, kept with the email record." },
            to: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, maxItems: 100 }] },
            cc: { type: "array", items: { type: "string" } },
            bcc: { type: "array", items: { type: "string" } },
            variables: { type: "object", additionalProperties: { oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] } },
            autoFill: { type: "boolean" },
            includeMime: { type: "boolean" },
            attachments: { type: "array", maxItems: 10, items: { type: "object", required: ["filename", "contentType", "contentBase64"], properties: { filename: { type: "string" }, contentType: { type: "string" }, contentBase64: { type: "string" } } } },
          },
        },
        RelayProvider: { type: "string", enum: ["ses", "sendgrid", "postmark", "mailgun"] },
      },
    },
    paths: {
      "/api/health": { get: { summary: "Server status and DKIM selector", security: [], responses: { "200": ok("Status") } } },
      "/api/workspace": { get: { summary: "Templates, domain, mailboxes, DNS", security: bearer, responses: { "200": ok("Workspace"), "401": err("Unauthorised") } }, put: { summary: "Replace the workspace (admin key)", security: bearer, requestBody: body({ type: "object" }), responses: { "200": ok("Saved"), "403": err("Admin key required"), "422": err("Invalid workspace") } } },
      "/api/compile": { post: { summary: "Compile and run the EW-101…108 gate without sending", security: bearer, requestBody: body({ $ref: "#/components/schemas/SendRequest" }), responses: { "200": ok("Preview and gate result") } } },
      "/api/send": { post: { summary: "Send one email", parameters: [{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", maxLength: 255 }, description: "Same key and body within 24 h returns the original response with `Idempotent-Replayed: true`; a different body is a 409." }], description: "201 delivered, 202 queued for retry, 403 blocked by the gate (no socket opened), 502 SMTP failure. Identical sends inside the dedupe window are blocked by EW-108, which makes retries safe.", security: bearer, requestBody: body({ $ref: "#/components/schemas/SendRequest" }), responses: { "201": ok("Delivered"), "202": ok("Queued"), "403": err("preflight_blocked"), "502": err("smtp_failed") } } },
      "/api/emails": { get: { summary: "List emails, newest first", description: "Filters: status, to (substring), template, domain, tag (name or name:value), since, until. Pagination: limit (1-100, default 20) and before=<id of the last item>; the response carries hasMore and nextCursor.", security: bearer, parameters: ["status", "to", "template", "domain", "tag", "since", "until", "limit", "before"].map((name) => ({ name, in: "query", required: false, schema: { type: "string" } })), responses: { "200": ok("Page of emails"), "400": err("Bad filter") } } },
      "/api/emails/{id}": { get: { summary: "One email with its status timeline", description: "status is the latest of queued, delivered, failed, bounced, complained, deferred; events lists everything including opens and clicks.", security: bearer, responses: { "200": ok("Email"), "404": err("Not found") } } },
      "/api/scheduled": { get: { summary: "Scheduled sends", security: bearer, responses: { "200": ok("Scheduled sends, newest first") } } },
      "/api/scheduled/{id}": { delete: { summary: "Cancel a scheduled send that has not run yet", security: bearer, responses: { "200": ok("Cancelled"), "404": err("Not found"), "409": err("Already ran or cancelled") } } },
      "/api/inbound": { get: { summary: "List received mail, newest first", description: "Filters: from, to, q (subject or snippet), kind (message, bounce, complaint), since, until. Pagination: limit and before=<id of the last item>.", security: bearer, parameters: ["from", "to", "q", "kind", "since", "until", "limit", "before"].map((name) => ({ name, in: "query", required: false, schema: { type: "string" } })), responses: { "200": ok("Page of received messages"), "400": err("Bad filter") } } },
      "/api/inbound/{id}": { get: { summary: "One received message with its decoded text, html and headers", description: "`html` is untrusted content from the sender: render it only inside a sandboxed frame with remote content blocked.", security: bearer, responses: { "200": ok("Message"), "404": err("Not found") } }, delete: { summary: "Delete a received message (admin key)", security: bearer, responses: { "200": ok("Deleted") } } },
      "/api/inbound/{id}/raw": { get: { summary: "The original message as received (message/rfc822)", security: bearer, responses: { "200": { description: "Raw message", content: { "message/rfc822": { schema: { type: "string", format: "binary" } } } } } } },
      "/api/inbound/{id}/attachments/{index}": { get: { summary: "Download one attachment", description: "Always served as an attachment with nosniff and a sandbox CSP; types that a browser could render (HTML, SVG, scripts, unknown) are served as application/octet-stream.", security: bearer, responses: { "200": { description: "File bytes", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } }, "404": err("Not found") } } },
      "/hooks/inbound/raw": { post: { summary: "Receive a message from a relay's inbound webhook", description: "Public endpoint authenticated by `?token=` equal to SEALPOST_WEBHOOK_SECRET; 404 when no secret is set. Accepts the raw message (message/rfc822 or text/plain), JSON { raw } or { rawBase64 }, an SES→SNS notification with `content`, or multipart/form-data with an `email` (SendGrid) or `body-mime` (Mailgun) field.", security: [], parameters: [{ name: "token", in: "query", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "message/rfc822": { schema: { type: "string" } }, "application/json": { schema: { type: "object" } }, "multipart/form-data": { schema: { type: "object" } } } }, responses: { "200": ok("Stored"), "400": err("No message found"), "401": err("Invalid token"), "413": err("Too large") } } },
      "/api/unsubscribe-link": { post: { summary: "Mint a hosted one-click unsubscribe URL for an address (needs unsubscribe.hosted and domain.trackingBaseUrl)", security: bearer, requestBody: body({ type: "object", required: ["email"], properties: { email: { type: "string" }, domain: { type: "string" } } }), responses: { "200": ok("URL"), "409": err("unsubscribe_not_enabled") } } },
      "/u/{token}": { get: { summary: "Unsubscribe confirmation page (never changes anything)", security: [], responses: { "200": { description: "HTML" }, "404": { description: "Invalid link" } } }, post: { summary: "Unsubscribe. Also the RFC 8058 one-click target (List-Unsubscribe=One-Click)", security: [], responses: { "200": { description: "HTML" } } } },
      "/api/import": { post: { summary: "Preview importing an MJML, React Email (JSX) or HTML template", description: "Nothing is saved: the response is a validated Sealpost template plus `warnings` describing what was approximated. Save it by PUT /api/workspace (admin key). React Email JSX is read statically and never executed.", security: bearer, requestBody: body({ type: "object", required: ["source"], properties: { source: { type: "string", maxLength: 2000000 }, format: { enum: ["mjml", "html", "react"] }, id: { type: "string" }, name: { type: "string" }, category: { enum: ["Auth", "Billing", "Incidents", "Growth", "Transactional"] } } }), responses: { "200": ok("Template and warnings"), "422": err("import_failed") } } },
      "/api/doctor": { post: { summary: "Pre-launch checks: relay login, live DNS, tracking, unsubscribe (admin key)", security: bearer, responses: { "200": ok("Checks") } } },
      "/api/auth-check": { post: { summary: "Parse a received message's Authentication-Results into DKIM, SPF and DMARC verdicts", security: bearer, requestBody: body({ type: "object", required: ["raw"], properties: { raw: { type: "string" } } }), responses: { "200": ok("Report") } } },
      "/api/setup": { put: { summary: "Save domain, transport and mailboxes immediately (admin key)", security: bearer, requestBody: body({ type: "object" }), responses: { "200": ok("Saved"), "422": err("Invalid") } } },
      "/api/send/batch": { post: { summary: "Send up to 100 emails; each result is reported individually", security: bearer, requestBody: body({ type: "object", required: ["emails"], properties: { emails: { type: "array", minItems: 1, maxItems: 100, items: { $ref: "#/components/schemas/SendRequest" } } } }), responses: { "200": ok("Per-email results") } } },
      "/api/stats": { get: { summary: "Sent, opens, clicks, bounces, complaints and rates", security: bearer, responses: { "200": ok("Stats") } } },
      "/api/stats/timeseries": { get: { summary: "Per-day sent, delivered, bounced, failed, opens and clicks (UTC), zero-filled", security: bearer, parameters: [{ name: "days", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 90, default: 14 } }], responses: { "200": ok("Days, oldest first"), "400": err("Bad days") } } },
      "/api/events": { get: { summary: "Open, click, delivery, bounce and complaint events", security: bearer, responses: { "200": ok("Events") } } },
      "/api/inbox": { get: { summary: "Test inbox (sink transport)", security: bearer, responses: { "200": ok("Messages") } }, delete: { summary: "Clear the test inbox (admin key)", security: bearer, responses: { "200": ok("Cleared") } } },
      "/api/suppressions": { get: { summary: "List suppressed recipients", security: bearer, responses: { "200": ok("Suppressions") } }, post: { summary: "Add a suppression", security: bearer, requestBody: body({ type: "object", required: ["email"], properties: { email: { type: "string" }, reason: { enum: ["hard_bounce", "unsubscribed", "complaint"] }, detail: { type: "string" } } }), responses: { "201": ok("Added") } }, delete: { summary: "Remove a suppression (?email=)", security: bearer, responses: { "200": ok("Removed") } } },
      "/api/ledger": { get: { summary: "Delivery ledger records", security: bearer, responses: { "200": ok("Records") } } },
      "/api/ledger/verify": { get: { summary: "Verify the hash chain and every receipt", security: bearer, responses: { "200": ok("Verification") } } },
      "/api/verify": { post: { summary: "Verify an evw_ receipt, optionally against stored MIME", security: bearer, requestBody: body({ type: "object", required: ["token"], properties: { token: { type: "string" }, inboxId: { type: "string" } } }), responses: { "200": ok("Verification") } } },
      "/api/dns": { get: { summary: "SPF, DKIM, DMARC and MX records to publish", security: bearer, responses: { "200": ok("Records") } } },
      "/api/queue": { get: { summary: "Retry queue", security: bearer, responses: { "200": ok("Items") } } },
      "/api/queue/run": { post: { summary: "Process due retries now", security: bearer, responses: { "200": ok("Run summary") } } },
      "/api/domains": { get: { summary: "Sending domains with the DNS records to publish", security: bearer, responses: { "200": ok("Domains") } } },
      "/api/domains/{domain}/check": { get: { summary: "Live DNS lookup of SPF, DKIM and DMARC for one domain", security: bearer, parameters: [{ name: "domain", in: "path", required: true, schema: { type: "string" } }], responses: { "200": ok("Per-record status"), "404": err("Unknown domain") } } },
      "/api/audiences": { get: { summary: "List audiences", security: bearer, responses: { "200": ok("Audiences") } }, post: { summary: "Create an audience", security: bearer, requestBody: body({ type: "object", required: ["name"], properties: { name: { type: "string" } } }), responses: { "201": ok("Created") } } },
      "/api/audiences/{id}": { get: { summary: "Audience with a page of contacts (?offset=&limit=)", security: bearer, responses: { "200": ok("Audience"), "404": err("Not found") } }, delete: { summary: "Delete an audience (blocked while a broadcast uses it)", security: bearer, responses: { "200": ok("Deleted"), "409": err("In use") } } },
      "/api/audiences/{id}/contacts": {
        post: { summary: "Add or update up to 10,000 contacts", security: bearer, requestBody: body({ type: "object", required: ["contacts"], properties: { contacts: { type: "array", items: { type: "object", required: ["email"], properties: { email: { type: "string" }, name: { type: "string" }, variables: { type: "object" } } } } } }), responses: { "200": ok("Counts and rejected addresses") } },
        delete: { summary: "Remove one contact (?email=)", security: bearer, responses: { "200": ok("Removed") } },
      },
      "/api/broadcasts": { get: { summary: "List broadcasts", security: bearer, responses: { "200": ok("Broadcasts") } }, post: { summary: "Schedule a template to an audience", security: bearer, requestBody: body({ type: "object", required: ["name", "audienceId", "templateId"], properties: { name: { type: "string" }, audienceId: { type: "string" }, templateId: { type: "string" }, domain: { type: "string" }, variables: { type: "object" }, scheduledAtIso: { type: "string", format: "date-time" }, ratePerMinute: { type: "integer", minimum: 1, maximum: 6000 } } }), responses: { "201": ok("Scheduled") } } },
      "/api/broadcasts/{id}": { get: { summary: "Broadcast with live counters", security: bearer, responses: { "200": ok("Broadcast") } } },
      "/api/broadcasts/{id}/cancel": { post: { summary: "Cancel a scheduled or running broadcast", security: bearer, responses: { "200": ok("Cancelled"), "409": err("Already finished") } } },
      "/api/webhooks": { get: { summary: "Outbound webhook endpoints with delivery counts", security: bearer, responses: { "200": ok("Endpoints") } } },
      "/api/webhooks/deliveries": { get: { summary: "Recent outbound deliveries", security: bearer, responses: { "200": ok("Deliveries") } } },
      "/api/webhooks/{id}/test": { post: { summary: "Send a webhook.ping to one endpoint (admin key)", security: bearer, responses: { "202": ok("Queued"), "404": err("No such endpoint") } } },
      "/hooks/relay/{provider}": {
        post: {
          summary: "Relay feedback webhook (bounces, complaints, deliveries)",
          description: "Public endpoint authenticated by `?token=` equal to SEALPOST_WEBHOOK_SECRET; disabled (404) when no secret is set. Hard bounces and complaints suppress the recipient.",
          security: [],
          parameters: [{ name: "provider", in: "path", required: true, schema: { $ref: "#/components/schemas/RelayProvider" } }, { name: "token", in: "query", required: true, schema: { type: "string" } }],
          requestBody: body({ type: "object" }),
          responses: { "200": ok("Processed"), "401": err("Invalid token"), "404": err("Disabled or unknown provider") },
        },
      },
    },
  };
}
