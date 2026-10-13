import { readFileSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests in the installed Microsoft Edge (no browser download) with a Chrome DevTools
 * Protocol virtual FIDO2 authenticator (CTAP2, USB, resident keys, user verification). They start
 * their own dev server on 3301 (origin http://localhost:3301, own build folder .next-e2e) against
 * the database prepared by scripts/e2e-db.mjs. Needs PostgreSQL; not run in CI.
 */
const env = new Map<string, string>();
for (const line of readFileSync(".env.e2e", "utf8").split(/\r?\n/)) {
  const eq = line.indexOf("=");
  if (eq > 0 && !line.startsWith("#")) env.set(line.slice(0, eq), line.slice(eq + 1));
}

export default defineConfig({
  testDir: "e2e",
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3301",
    channel: "msedge",
    trace: "retain-on-failure",
    locale: "en-GB",
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: "edge", use: { ...devices["Desktop Edge"], channel: "msedge", viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: "npx next dev --hostname 127.0.0.1 --port 3301",
    url: "http://localhost:3301/api/health",
    timeout: 240_000,
    reuseExistingServer: false,
    env: {
      NEXT_DIST_DIR: ".next-e2e",
      ADMIN_ORIGIN: "http://localhost:3301",
      ADMIN_PG_DATABASE: env.get("ADMIN_PG_DATABASE") ?? "",
      ADMIN_PG_USER: env.get("ADMIN_PG_USER") ?? "",
      ADMIN_PG_PASSWORD: env.get("ADMIN_PG_PASSWORD") ?? "",
    },
  },
});
