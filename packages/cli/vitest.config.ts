import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  define: { __VERSION__: JSON.stringify("test") },
  resolve: { alias: { "@sealpost/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)) } },
  test: { testTimeout: 20000 },
});
