import type { NextConfig } from "next";

// Baseline security headers for every response (same as the website, stricter where possible).
// The nonce-based Content-Security-Policy and the Host check are in src/proxy.ts.
const https = (process.env.ADMIN_ORIGIN ?? "").startsWith("https://");
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  // publickey-credentials-get/create: WebAuthn only in this document, never in a frame.
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), publickey-credentials-get=(self), publickey-credentials-create=(self)",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  // Nothing an officer sees is cached by the browser or any proxy.
  { key: "Cache-Control", value: "no-store" },
  ...(process.env.NODE_ENV === "production" && https
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
    : []),
];

const config: NextConfig = {
  // The end-to-end and HTTP-matrix servers build into their own folders; only these names are accepted.
  distDir: process.env.NEXT_DIST_DIR === ".next-e2e" || process.env.NEXT_DIST_DIR === ".next-http" ? process.env.NEXT_DIST_DIR : ".next",
  poweredByHeader: false,
  reactStrictMode: true,
  // Officers reach the server at http://localhost:<port> (WebAuthn RP ID) while it binds 127.0.0.1.
  allowedDevOrigins: ["localhost"],
  experimental: {
    // forbidden() renders app/forbidden.tsx with HTTP 403.
    authInterrupts: true,
  },
  headers() {
    return Promise.resolve([
      // Static assets are content-hashed and public (fonts, scripts); everything else: no-store.
      { source: "/:path*", headers: securityHeaders },
    ]);
  },
};

export default config;
