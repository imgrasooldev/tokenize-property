// Prepares the end-to-end database: re-creates pt_admin_e2e with all migrations and a fresh
// least-privilege login (pt_admin_e2e_web), and writes the credentials to admin/.env.e2e
// (git-ignored) for playwright.config.ts. Never touches property_token or pt_admin_dev.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMigratedDatabase, ensurePortalLogin, REPO_ROOT } from "./lib-db.mjs";

const DB = process.env.ADMIN_E2E_DB === "pt_admin_dev" ? "pt_admin_dev" : "pt_admin_e2e";
const LOGIN = "pt_admin_e2e_web";
const applied = await createMigratedDatabase(DB, { recreate: DB === "pt_admin_e2e" });
const password = await ensurePortalLogin(LOGIN);
writeFileSync(
  join(REPO_ROOT, "admin", ".env.e2e"),
  `# Written by scripts/e2e-db.mjs (never commit)\nADMIN_PG_DATABASE=${DB}\nADMIN_PG_USER=${LOGIN}\nADMIN_PG_PASSWORD=${password}\n`,
  { mode: 0o600 },
);
console.log(`${DB}: ${String(applied.length)} migration(s) applied; login ${LOGIN}`);
