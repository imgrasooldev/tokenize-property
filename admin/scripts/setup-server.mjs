// Demo server only (deploy/demo-server/update.sh): gives the portal its least-privilege database
// login on the server's database (property_token, migrated by backend `npm run migrate`) and writes
// admin/.env.local (git-ignored). Idempotent: a new random password on every run, written at once.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePortalLogin, REPO_ROOT } from "./lib-db.mjs";

const file = join(REPO_ROOT, "admin", ".env.local");
const password = await ensurePortalLogin("pt_admin_web");
const keep = existsSync(file)
  ? readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith("#") && !/^(ADMIN_PG_DATABASE|ADMIN_PG_USER|ADMIN_PG_PASSWORD|ADMIN_ORIGIN)=/.test(l))
  : [];
writeFileSync(
  file,
  [
    "# Written by scripts/setup-server.mjs (never commit)",
    ...keep,
    "ADMIN_PG_DATABASE=property_token",
    "ADMIN_PG_USER=pt_admin_web",
    `ADMIN_PG_PASSWORD=${password}`,
    "ADMIN_ORIGIN=http://localhost:3300",
    "",
  ].join("\n"),
  { mode: 0o600 },
);
console.log("admin portal: login pt_admin_web (member of pt_admin_portal only) ready; wrote admin/.env.local");
