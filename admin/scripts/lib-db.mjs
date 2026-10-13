// Database helpers shared by the local setup script, the end-to-end setup and the tests.
// They use the PostgreSQL ADMIN account (from env or backend/.env.local) and never touch the
// main `property_token` database: callers pass their own database names, refused below.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");
export const MIGRATIONS_DIR = join(REPO_ROOT, "backend", "packages", "db", "migrations");

/** Databases these helpers may create, migrate or drop. Never the demo or test databases of other apps. */
const ALLOWED_NAME = /^(pt_admin_[a-z0-9_]{1,40}|pt_scratch_admin_[0-9_]{1,40})$/;

export function readEnvFile(file) {
  const env = {};
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0 && !line.startsWith("#")) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return env;
}

/** PostgreSQL admin connection: CI passes PG_* variables; locally they come from backend/.env.local. */
export function adminSettings(database = "postgres") {
  const local = readEnvFile(join(REPO_ROOT, "backend", ".env.local"));
  const password = process.env.PG_ADMIN_PASSWORD ?? local.PG_ADMIN_PASSWORD;
  if (!password) throw new Error("No PostgreSQL admin password: run `python backend/scripts/pg.py setup` or set PG_ADMIN_PASSWORD");
  return {
    host: process.env.PG_HOST ?? local.PG_HOST ?? "127.0.0.1",
    port: Number(process.env.PG_PORT ?? local.PG_PORT ?? 5433),
    user: process.env.PG_ADMIN_USER ?? local.PG_ADMIN_USER ?? "pt_admin",
    password,
    database,
  };
}

function checkName(name) {
  if (!ALLOWED_NAME.test(name)) throw new Error(`refusing database name ${name}: only pt_admin_* or pt_scratch_admin_* are managed here`);
}

/** Applies every migration in order (same files and checksum table as backend `npm run migrate`). */
export async function applyMigrations(client) {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
    name text PRIMARY KEY, sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'), applied_at timestamptz NOT NULL DEFAULT now())`);
  const { rows } = await client.query("SELECT name, sha256 FROM public.schema_migrations");
  const done = new Map(rows.map((r) => [r.name, r.sha256]));
  const applied = [];
  for (const name of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    const sha = createHash("sha256").update(sql).digest("hex");
    if (done.has(name)) {
      if (done.get(name) !== sha) throw new Error(`migration ${name} changed after it was applied`);
      continue;
    }
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO public.schema_migrations (name, sha256) VALUES ($1, $2)", [name, sha]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${name} failed: ${e.message}`, { cause: e });
    }
    applied.push(name);
  }
  return applied;
}

/** Creates (or re-creates) a database and applies all migrations. */
export async function createMigratedDatabase(name, { recreate = false } = {}) {
  checkName(name);
  const admin = new pg.Client(adminSettings());
  await admin.connect();
  try {
    const exists = (await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rowCount === 1;
    if (exists && recreate) await dropDatabase(name, admin);
    if (!exists || recreate) await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const client = new pg.Client(adminSettings(name));
  await client.connect();
  try {
    return await applyMigrations(client);
  } finally {
    await client.end();
  }
}

export async function dropDatabase(name, existing) {
  checkName(name);
  const admin = existing ?? new pg.Client(adminSettings());
  if (!existing) await admin.connect();
  try {
    for (let i = 0; i < 40; i++) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${name}`);
        return;
      } catch (e) {
        if (e.code !== "55006") throw e; // object_in_use: a session is still closing
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    if (!existing) await admin.end();
  }
}

/**
 * A LOGIN role for the portal that is only a member of pt_admin_portal (least privilege). The
 * password is new on every call and returned to the caller, who keeps it out of git.
 */
export async function ensurePortalLogin(login) {
  if (!/^pt_admin_[a-z0-9_]{2,40}$/.test(login)) throw new Error("bad login role name");
  const password = randomBytes(24).toString("base64url");
  const admin = new pg.Client(adminSettings());
  await admin.connect();
  try {
    const exists = (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [login])).rowCount === 1;
    const verb = exists ? "ALTER" : "CREATE";
    // The password is random base64url (no quotes possible); identifiers are checked above.
    await admin.query(`${verb} ROLE ${login} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${password}'`);
    // INHERIT on the membership only: the login gets exactly pt_admin_portal's rights.
    await admin.query(`GRANT pt_admin_portal TO ${login} WITH INHERIT TRUE`);
  } finally {
    await admin.end();
  }
  return password;
}
