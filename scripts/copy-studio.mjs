// Copies the static Studio export (./out) into the CLI package so `sealpost studio` can serve it.
import { cpSync, existsSync, rmSync } from "node:fs";

if (!existsSync("out/index.html")) {
  console.error("out/index.html not found. Run `npm run build:studio` first.");
  process.exit(1);
}
rmSync("packages/cli/studio-dist", { recursive: true, force: true });
cpSync("out", "packages/cli/studio-dist", { recursive: true });
console.log("Studio copied to packages/cli/studio-dist");
