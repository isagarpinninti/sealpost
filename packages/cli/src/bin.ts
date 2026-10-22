#!/usr/bin/env node
import { run } from "./commands";
import { defaultIo } from "./ui";

run(process.argv.slice(2), defaultIo()).then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
