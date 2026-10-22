import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests in a real browser (the installed Microsoft Edge, so no browser download).
 * They start their own dev server on port 3101 against the TEST database (property_token_test),
 * next to the demo server on 3100. Needs the local chain and PostgreSQL running; not run in CI.
 */
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
    channel: "msedge",
    trace: "retain-on-failure",
    locale: "en-GB",
  },
  projects: [{ name: "edge", use: { ...devices["Desktop Edge"], channel: "msedge" } }],
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
