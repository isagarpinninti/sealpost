# Audiences and broadcasts

An **audience** is a list of contacts. A **broadcast** sends one template to every contact in an audience, now or at a scheduled time, throttled to a rate you choose. Each email still goes through the full pipeline: pre-flight gate, DKIM, receipt, ledger.

## Audiences

```bash
sealpost audience create "Customers"                      # prints aud_xxxxxxxxxx
sealpost audience add aud_… ada@example.org --name Ada --var plan=pro
sealpost audience import aud_… people.csv                 # header: email,name,<any variable columns>
sealpost audience show aud_…
```

CSV columns other than `email` and `name` become per-contact template variables. Addresses are lower-cased and de-duplicated; invalid ones are reported, not silently dropped. Limit: 100,000 contacts per audience.

## Broadcasts

```bash
sealpost broadcast create "Launch" --audience aud_… --template workspace_team_invitation \
  --at 2026-11-01T09:00:00Z --rate 300 --var signInUrl=https://app.example.com/in
sealpost studio                                            # the scheduler runs in the server process
sealpost broadcast list
sealpost broadcast cancel brd_…
sealpost broadcast run                                     # or: run due broadcasts now, from the CLI
```

Template variables are merged in this order, later wins: the broadcast's `--var`s, the contact's `name` and `email`, then the contact's own variables. A contact missing a required variable is counted as `blocked` (EW-101) without stopping the rest.

## Counters

| Counter | Meaning |
| --- | --- |
| `delivered`, `queued` | Accepted by the relay, or queued for retry |
| `suppressed` | On the suppression list (unsubscribed, bounced, complained): EW-107 |
| `duplicate` | The identical email was already sent inside the dedupe window: EW-108 |
| `blocked` | Another gate failure (missing variable, bad link, …) |
| `failed` | Permanent SMTP failure |

## Behaviour you can rely on

- **Rate**: `ratePerMinute / 60` emails per second per running broadcast (1 to 6,000 per minute).
- **Snapshot**: the audience is copied when the broadcast starts; later edits do not change a running broadcast.
- **Restart-safe**: progress is saved after every email. After a crash it resumes at the cursor, and the idempotency gate prevents a second copy of anything already sent.
- **Unsubscribes**: add them with `sealpost suppress add` or `POST /api/suppressions`; the next broadcast skips them. Put a working unsubscribe link in your template and set `unsubscribeUrl` on the domain for the `List-Unsubscribe` headers.
- **Events**: `broadcast.started` and `broadcast.completed` webhooks, plus every per-email event.

## REST and SDKs

`POST /api/audiences`, `POST /api/audiences/{id}/contacts`, `POST /api/broadcasts`, `GET /api/broadcasts/{id}`, `POST /api/broadcasts/{id}/cancel` (see `/api/openapi.json`). The same calls are in `@sealpost/sdk`, the Python package and the Go module. The Studio has an **Audiences & Broadcasts** view (⌘7).
