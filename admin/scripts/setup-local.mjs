// LOCAL DEV ONLY. Creates (or upgrades) the portal's own development database pt_admin_dev with all
// backend migrations, a least-privilege login role pt_admin_web (member of pt_admin_portal only) with a
// new random password, and writes admin/.env.local (git-ignored). Never touches property_token.
//   npm run setup:local            # create or upgrade
//   npm run setup:local -- --fresh # drop and re-create pt_admin_dev
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMigratedDatabase, ensurePortalLogin, REPO_ROOT } from "./lib-db.mjs";

const DB = "pt_admin_dev";
const LOGIN = "pt_admin_web";
const file = join(REPO_ROOT, "admin", ".env.local");

const applied = await createMigratedDatabase(DB, { recreate: process.argv.includes("--fresh") });
const password = await ensurePortalLogin(LOGIN);

const keep = existsSync(file)
  ? readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((l) => l && !/^(ADMIN_PG_DATABASE|ADMIN_PG_USER|ADMIN_PG_PASSWORD|ADMIN_ORIGIN)=/.test(l))
  : [];
writeFileSync(
  file,
  [
    "# Written by npm run setup:local (LOCAL DEV ONLY, never commit)",
    ...keep.filter((l) => !l.startsWith("# Written by")),
    `ADMIN_PG_DATABASE=${DB}`,
    `ADMIN_PG_USER=${LOGIN}`,
    `ADMIN_PG_PASSWORD=${password}`,
    "ADMIN_ORIGIN=http://localhost:3300",
    "",
  ].join("\n"),
  { mode: 0o600 },
);
console.log(`${DB}: applied ${applied.length} migration(s); login ${LOGIN} (member of pt_admin_portal only); wrote admin/.env.local`);
console.log("Next: npm run officer -- bootstrap <handle> \"<Full Name>\"  then  npm run dev  and open http://localhost:3300");
