import { fileURLToPath } from "node:url";
import { readEnvFile } from "@pt/config";
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
