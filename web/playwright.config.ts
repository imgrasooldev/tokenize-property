import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests in a real browser (the installed Microsoft Edge, so no browser download).
 * They start their own dev server on port 3101 against the TEST database (property_token_test),
 * next to the demo server on 3100. Needs the local Besu chain (net.py + flow.py deployment) and
 * PostgreSQL running; LOCAL ONLY (T-011: the four-validator chain, flow.py's timelock waits and the
 * cold dev-server compiles do not fit a CI job; CI runs the chain-independent passkey e2e instead).
 * PW_BROWSER=chromium uses Playwright's Chromium instead of the installed Edge.
 */
const chromium = process.env.PW_BROWSER === "chromium";
const browser = chromium
  ? { name: "chromium", use: { ...devices["Desktop Chrome"] } }
  : { name: "edge", use: { ...devices["Desktop Edge"], channel: "msedge" } };

export default defineConfig({
  testDir: "e2e",
  // Passkeys need http://localhost (an IP address cannot be a WebAuthn RP ID): own run, playwright.passkey.config.ts.
  testIgnore: "passkey.spec.ts",
  // Tests share one chain and one test database; run them one after another.
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3101",
    ...(chromium ? {} : { channel: "msedge" }),
    trace: "retain-on-failure",
    locale: "en-GB",
  },
  projects: [browser],
  webServer: [
    {
      // Indexer, signing service (4901), outbox worker and KYC service (4911) for the TEST database
      // (Step 5h: the website signs nothing and reads the chain index).
      command: "npx tsx test/stack-cli.ts",
      url: "http://127.0.0.1:4919/ready",
      timeout: 400_000,
      reuseExistingServer: false,
    },
    {
      command: "npx next dev --hostname 127.0.0.1 --port 3101",
      url: "http://127.0.0.1:3101/login",
      timeout: 180_000,
      reuseExistingServer: false,
      env: { WEB_DB_NAME: "property_token_test", NEXT_DIST_DIR: ".next-e2e", SIGNER_URL: "http://127.0.0.1:4901", KYC_URL: "http://127.0.0.1:4911" },
    },
  ],
});
