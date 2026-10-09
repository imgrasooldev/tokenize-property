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
export async function scratchDatabase(): Promise<{ client: pg.Client; drop: () => Promise<void> }> {
  const name = `pt_scratch_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new pg.Client(adminSettings());
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const client = new pg.Client(adminSettings(name));
  await client.connect();
  return {
    client,
    drop: async () => {
      await client.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
