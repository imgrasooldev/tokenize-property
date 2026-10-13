// Prepares the end-to-end database: re-creates pt_admin_e2e with all migrations and a fresh
// least-privilege login (pt_admin_e2e_web), and writes the credentials to admin/.env.e2e
// (git-ignored) for playwright.config.ts. Step 6b: also two random client secrets for the test
// signing service that playwright.config.ts starts next to the portal (never real secrets).
// Never touches property_token or pt_admin_dev.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMigratedDatabase, ensurePortalLogin, REPO_ROOT } from "./lib-db.mjs";

const DB = process.env.ADMIN_E2E_DB === "pt_admin_dev" ? "pt_admin_dev" : "pt_admin_e2e";
const LOGIN = "pt_admin_e2e_web";
const applied = await createMigratedDatabase(DB, { recreate: DB === "pt_admin_e2e" });
const password = await ensurePortalLogin(LOGIN);
const secret = () => randomBytes(32).toString("base64url");
writeFileSync(
  join(REPO_ROOT, "admin", ".env.e2e"),
  [
    "# Written by scripts/e2e-db.mjs (never commit)",
    `ADMIN_PG_DATABASE=${DB}`,
    `ADMIN_PG_USER=${LOGIN}`,
    `ADMIN_PG_PASSWORD=${password}`,
    `SIGNER_CLIENT_SECRET_ADMIN=${secret()}`,
    `SIGNER_CLIENT_SECRET_OUTBOX=${secret()}`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);
console.log(`${DB}: ${String(applied.length)} migration(s) applied; login ${LOGIN}`);
