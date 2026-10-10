import type { NextConfig } from "next";

// Baseline security headers for every response. The nonce-based Content-Security-Policy is set
// per request in src/proxy.ts.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // HTTPS only in production (the local prototype is plain HTTP on 127.0.0.1).
  ...(process.env.NODE_ENV === "production"
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
    : []),
];

const config: NextConfig = {
  // The end-to-end test server (port 3101, test database) builds into its own folder so it can run
  // next to the demo server. Only these two fixed names are accepted.
  distDir: process.env.NEXT_DIST_DIR === ".next-e2e" ? ".next-e2e" : ".next",
  poweredByHeader: false,
  reactStrictMode: true,
  headers() {
    return Promise.resolve([{ source: "/:path*", headers: securityHeaders }]);
  },
};

export default config;
