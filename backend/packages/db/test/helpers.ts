import { randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvFile, SERVICE_DB_ROLES, type ServiceName } from "@pt/config";
import pg from "pg";

const local = readEnvFile(fileURLToPath(new URL("../../../.env.local", import.meta.url)));

/** Admin connection settings: CI provides PG_* env vars; locally they come from backend/.env.local. */
export function adminSettings(database = "postgres"): pg.ClientConfig {
  const password = process.env.PG_ADMIN_PASSWORD ?? local.PG_ADMIN_PASSWORD;
  if (!password) throw new Error("No admin password: run `python backend/scripts/pg.py setup` or set PG_ADMIN_PASSWORD");
  return {
    host: process.env.PG_HOST ?? local.PG_HOST ?? "127.0.0.1",
    port: Number(process.env.PG_PORT ?? local.PG_PORT ?? 5433),
    user: process.env.PG_ADMIN_USER ?? local.PG_ADMIN_USER ?? "pt_admin",
    password,
    database,
  };
}

/**
 * A throw-away LOGIN role in one service's group role (T-012, migration 0029), named per process
 * (`<login>_t<pid>_<random>`) because roles are cluster-wide and parallel runs share a cluster.
 * Returns connection settings for `database` as that role; `drop()` removes the login (end its
 * pools first).
 */
export async function serviceLogin(service: ServiceName, database: string): Promise<{
  settings: pg.ClientConfig;
  user: string;
  drop: () => Promise<void>;
}> {
  const { group, login } = SERVICE_DB_ROLES[service];
  const user = `${login}_t${String(process.pid)}_${randomBytes(3).toString("hex")}`;
  const password = randomBytes(24).toString("base64url");
  const root = new pg.Client(adminSettings());
  await root.connect();
  try {
    await root.query(`CREATE ROLE ${user} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${root.escapeLiteral(password)}`);
    await root.query(`GRANT ${group} TO ${user} WITH INHERIT TRUE, SET FALSE`);
  } finally {
    await root.end();
  }
  return {
    settings: { ...adminSettings(database), user, password },
    user,
    drop: async () => {
      const r = new pg.Client(adminSettings());
      await r.connect();
      try {
        await r.query(`DROP ROLE IF EXISTS ${user}`);
      } finally {
        await r.end();
      }
    },
  };
}

/** `serviceLogin` plus a pool on it; `drop()` ends the pool and removes the login. */
export async function servicePool(service: ServiceName, database: string, max = 4): Promise<{ pool: pg.Pool; drop: () => Promise<void> }> {
  const login = await serviceLogin(service, database);
  const pool = new pg.Pool({ ...login.settings, max });
  return {
    pool,
    drop: async () => {
      await pool.end();
      await login.drop();
    },
  };
}

/** Creates a throw-away database and returns a connected client plus a cleanup function. */
export async function scratchDatabase(): Promise<{
  client: pg.Client;
  settings: pg.ClientConfig;
  drop: () => Promise<void>;
}> {
  const name = `pt_scratch_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new pg.Client(adminSettings());
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const settings = adminSettings(name);
  const client = new pg.Client(settings);
  await client.connect();
  return {
    client,
    settings,
    drop: async () => {
      // A backend can still be closing when end() resolves. Terminating it then sends this client
      // an error event; without a listener Node treats it as an uncaught exception (flaky CI).
      client.on("error", ignoreTerminated);
      await client.end();
      await dropWhenFree(admin, name);
      await admin.end();
    },
  };
}

/** 57P01 = admin_shutdown: the expected result of dropping a database with connections left. */
function ignoreTerminated(e: Error & { code?: string }): void {
  if (e.code !== "57P01") throw e;
}

/** Drops the database once its sessions have closed; FORCE only as a last resort. */
async function dropWhenFree(admin: pg.Client, name: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      await admin.query(`DROP DATABASE ${name}`);
      return;
    } catch (e) {
      if ((e as { code?: string }).code !== "55006") throw e; // 55006 = object_in_use
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
}

/**
 * A temporary copy of the migrations directory holding only the files up to and including
 * `last` (e.g. "0007"), to build a database as it was before a later migration and then upgrade it.
 */
export function migrationsUpTo(last: string): string {
  const src = fileURLToPath(new URL("../migrations", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "pt-migrations-upto-"));
  for (const f of readdirSync(src)) {
    if (f.endsWith(".sql") && f.slice(0, 4) <= last) copyFileSync(join(src, f), join(dir, f));
  }
  return dir;
}

/**
 * A temporary copy of the migrations directory with contiguous numbering. While a migration of a
 * parallel branch is missing (Step 6b's 0016 is written before S-02's 0015 is merged), the runner
 * refuses the gap; this copy renumbers the files after it. Once both are merged it is identical to
 * the real directory. Scratch databases only.
 */
export function contiguousMigrations(): string {
  const src = fileURLToPath(new URL("../migrations", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "pt-migrations-contiguous-"));
  const files = readdirSync(src)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  files.forEach((f, i) => {
    copyFileSync(join(src, f), join(dir, `${String(i + 1).padStart(4, "0")}${f.slice(4)}`));
  });
  return dir;
}

/** Adds the remaining migrations (after `last`) to a directory made by `migrationsUpTo`. */
export function addMigrationsAfter(dir: string, last: string): void {
  const src = fileURLToPath(new URL("../migrations", import.meta.url));
  for (const f of readdirSync(src)) {
    if (f.endsWith(".sql") && f.slice(0, 4) > last) copyFileSync(join(src, f), join(dir, f));
  }
}
