import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  entry: { cli: "src/bin.ts", index: "src/index.ts" },
  format: ["esm"],
  dts: { entry: { index: "src/index.ts" } },
  clean: true,
  target: "node20",
  sourcemap: true,
  external: ["@sealpost/core", "zod", "pg"],
  define: { __VERSION__: JSON.stringify(pkg.version) },
});
