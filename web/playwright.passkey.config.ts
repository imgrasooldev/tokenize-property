import { defineConfig, devices } from "@playwright/test";

/**
 * Passkey end-to-end tests (T-030) in the installed Microsoft Edge with a Chrome DevTools Protocol
 * virtual authenticator. WebAuthn needs a secure context and a domain as RP ID, so this run uses
 * http://localhost:3102 (not 127.0.0.1 like the main e2e run) against its own throw-away database
 * pt_web_e2e, re-created at the latest migration before the server starts. No chain or backend
 * services are needed. Needs PostgreSQL. Runs in CI (T-011, job web-e2e) with Playwright's Chromium:
 * PW_BROWSER=chromium (the virtual authenticator is the same CDP feature in both).
 */
const chromium = process.env.PW_BROWSER === "chromium";
const browser = chromium
  ? { name: "chromium", use: { ...devices["Desktop Chrome"] } }
  : { name: "edge", use: { ...devices["Desktop Edge"], channel: "msedge" } };

export default defineConfig({
  testDir: "e2e",
  testMatch: "passkey.spec.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3102",
    ...(chromium ? {} : { channel: "msedge" }),
    trace: "retain-on-failure",
    locale: "en-GB",
  },
  projects: [browser],
  webServer: [
    {
      command: "npx tsx test/passkey-e2e-db.ts && npx next dev --hostname 127.0.0.1 --port 3102",
      url: "http://localhost:3102/login",
      timeout: 400_000,
      reuseExistingServer: false,
      env: { WEB_DB_NAME: "pt_web_e2e", WEB_ORIGIN: "http://localhost:3102", NEXT_DIST_DIR: ".next-e2e" },
    },
  ],
});
