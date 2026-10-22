# Contributing

```bash
npm install
npm run ci
```

`ci` builds the packages and Studio, lints, typechecks, runs the Vitest suites and the packaged-tarball smoke test.

## Ground rules

- No `any`, no `eval`, no TODO comments.
- `@sealpost/core` has zero runtime dependencies; do not add one. It must work on Zod 3.23+ and 4.
- Protocol behaviour (MIME, DKIM, SMTP) changes need a test, ideally one that cross-checks against `node:crypto` or an RFC vector rather than against our own code.
- Anything that sends bytes to a network address must pass through the SSRF guard.
- Never store or log a credential. Mailboxes reference environment variables.
- UI follows the monochrome theme; styles stay scoped under `.ew-root`.

## Layout

- `packages/core`: engine, `packages/react`: primitives, `packages/cli`: SMTP client, sink, server.
- `src/`: the Next.js Studio, exported statically and bundled into the CLI.

The Python, Go, Ruby and PHP SDKs live in `sdks/`. Test them with:

```bash
PYTHONPATH=sdks/python/src python3 -m unittest discover sdks/python/tests
cd sdks/go && go test ./...
ruby sdks/ruby/test/sealpost_test.rb
php sdks/php/tests/run.php
```

The Postgres tests start a throwaway cluster when `initdb` is installed (they are skipped otherwise).

Open an issue before starting anything large.
