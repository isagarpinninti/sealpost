# Postgres storage and running several Sealpost processes

By default Sealpost keeps its state in `.sealpost/` next to your config: keys, the delivery ledger, queues, logs, suppressions, audiences, received mail. That is the right choice for one process. Switch to Postgres when you want to run more than one (for example two instances behind a load balancer, or a worker next to the API), or you want the data in a database you already back up.

## Turn it on

```bash
npm install pg                                   # optional dependency of @sealpost/cli; the Docker image includes it
export DATABASE_URL="postgres://user:pass@db.internal:5432/sealpost?sslmode=require"
```

```json
"storage": { "type": "postgres", "urlEnv": "DATABASE_URL", "schema": "sealpost", "namespace": "default" }
```

The connection string lives only in the environment variable named by `urlEnv`; it is never written to the config. Sealpost creates the tables it needs (`sealpost.files`, `sealpost.log`) the first time it connects. `namespace` separates projects that share a database.

Config and templates stay on disk (they are your project's source). Everything under `.sealpost/` moves to the database, including the DKIM and receipt **private keys**: treat the database as the secret store it now is (encrypt at rest, restrict access, back it up).

## Moving an existing project

```bash
# 1. edit sealpost.config.json to set "storage" as above, and export DATABASE_URL
sealpost storage status
sealpost storage migrate                  # copies .sealpost/ into the database; refuses if it is not empty (--force to replace)
sealpost ledger verify                    # the chain and every receipt must still verify
sealpost doctor
```

The `.sealpost/` folder is left untouched as a backup. Keys are copied as-is, so DNS records and receipts stay valid.

## What "several processes" guarantees

With Postgres, `sealpost studio` can run on as many hosts as you like against the same namespace:

| Concern | How it is handled |
| --- | --- |
| Two processes receive the identical send | A database advisory lock orders the idempotency check; reservations are written to the database, so exactly one is delivered and the rest are blocked by EW-108 |
| Ledger hash chain | Appends happen under the same lock: one unbroken chain, never a fork |
| Retry queue | Each due item is claimed with a lease under the lock; two workers never send the same retry |
| Webhook deliveries | The same per-item lease |
| Broadcasts | One process at a time works on a given broadcast (a lease renewed each tick); a crashed worker's lease expires after a minute |
| Scheduled sends | Claimed under the lock before sending |
| First start on an empty database | Key creation runs under the lock, so every process ends up with the same keys |

These are tested against a real Postgres (two runtimes, concurrent sends, appends, queue and broadcast workers).

## What it does not do

- It is a **document-style** store, not a relational schema: whole files (queue, suppressions, audiences) are read and rewritten under the lock, and logs are scanned on read. That is fine for tens of thousands of records; it is not built for millions. Moving to per-row tables is a future step.
- The lock is database-wide per namespace, so throughput of the locked sections is serialised across processes. SMTP delivery itself happens outside the lock.
- The local test inbox and the in-memory sink are per process.
- Rate limits (`limits.sendsPerMinute`) are counted per process.
- Redirecting port 25 and TLS certificates are per host.
