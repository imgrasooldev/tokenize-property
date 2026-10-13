import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { adminSettings, REPO_ROOT } from "./scripts/lib-db.mjs";

/**
 * End-to-end tests in the installed Microsoft Edge (no browser download) with a Chrome DevTools
 * Protocol virtual FIDO2 authenticator (CTAP2, USB, resident keys, user verification). They start
 * their own dev server on 3301 (origin http://localhost:3301, own build folder .next-e2e) against
 * the database prepared by scripts/e2e-db.mjs. Needs PostgreSQL; not run in CI.
 *
 * Step 6b: on the e2e database a real signing service (backend serve-test: SignerService and its
 * HTTP API with a temporary key and fixed chain facts) runs on 4997 next to the portal, with the
 * random client secrets that scripts/e2e-db.mjs wrote to .env.e2e.
 */
const env = new Map<string, string>();
for (const line of readFileSync(".env.e2e", "utf8").split(/\r?\n/)) {
  const eq = line.indexOf("=");
  if (eq > 0 && !line.startsWith("#")) env.set(line.slice(0, eq), line.slice(eq + 1));
}
const database = env.get("ADMIN_PG_DATABASE") ?? "";
const E2E_SIGNER_PORT = 4997;
const pg = adminSettings(database);

const portal = {
  command: "npx next dev --hostname 127.0.0.1 --port 3301",
  url: "http://localhost:3301/api/health",
  timeout: 240_000,
  reuseExistingServer: false,
  env: {
    NEXT_DIST_DIR: ".next-e2e",
    ADMIN_ORIGIN: "http://localhost:3301",
    ADMIN_PG_DATABASE: database,
    ADMIN_PG_USER: env.get("ADMIN_PG_USER") ?? "",
    ADMIN_PG_PASSWORD: env.get("ADMIN_PG_PASSWORD") ?? "",
    SIGNER_URL: `http://127.0.0.1:${String(E2E_SIGNER_PORT)}`,
    SIGNER_CLIENT_SECRET_ADMIN: env.get("SIGNER_CLIENT_SECRET_ADMIN") ?? "",
  },
};

const signer = {
  command: `"${process.execPath}" node_modules/tsx/dist/cli.mjs packages/signer/scripts/serve-test.ts`,
  cwd: join(REPO_ROOT, "backend"),
  url: `http://127.0.0.1:${String(E2E_SIGNER_PORT)}/v1/health`,
  timeout: 120_000,
  reuseExistingServer: false,
  env: {
    PG_HOST: String(pg.host),
    PG_PORT: String(pg.port),
    PG_ADMIN_USER: String(pg.user),
    PG_ADMIN_PASSWORD: String(pg.password),
    PG_DATABASE: database,
    SIGNER_PORT: String(E2E_SIGNER_PORT),
    SIGNER_CLIENT_SECRET_ADMIN: env.get("SIGNER_CLIENT_SECRET_ADMIN") ?? "",
    SIGNER_CLIENT_SECRET_OUTBOX: env.get("SIGNER_CLIENT_SECRET_OUTBOX") ?? "",
  },
};

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
  // The test signing service only runs on the throw-away e2e database (it refuses any other).
  webServer: database === "pt_admin_e2e" ? [portal, signer] : [portal],
});
