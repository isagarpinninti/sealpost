import type { NextConfig } from "next";

/**
 * Two modes:
 *  - `STUDIO_EXPORT=1 next build` → a fully static Studio that the `sealpost` CLI bundles and serves.
 *  - `next dev` → proxies /api to a running `sealpost studio` server (default port 4320).
 */
const exporting = process.env.STUDIO_EXPORT === "1";

const nextConfig: NextConfig = {
  turbopack: {
    rules: {
      "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" },
    },
  },
  ...(exporting ? { output: "export" as const, images: { unoptimized: true }, trailingSlash: false } : {}),
  ...(exporting
    ? {}
    : {
        async rewrites() {
          const target = process.env.SEALPOST_SERVER ?? "http://127.0.0.1:4320";
          return [{ source: "/api/:path*", destination: `${target}/api/:path*` }];
        },
      }),
};

export default nextConfig;
