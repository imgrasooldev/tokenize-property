import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

/**
 * Re-creates the throw-away database of the passkey end-to-end run (`npm run test:e2e:passkey`):
 * pt_web_e2e at the latest migration (contiguous numbering, so a reserved number that is not merged
 * yet does not block it). Nothing else is touched. Needs PostgreSQL and backend/.env.local.
 */
const DB = "pt_web_e2e";
const helpersUrl = pathToFileURL(join(import.meta.dirname, "..", "..", "backend", "packages", "db", "test", "helpers.ts")).href;
const migrateUrl = pathToFileURL(join(import.meta.dirname, "..", "..", "backend", "packages", "db", "src", "migrate.ts")).href;
const helpers = (await import(helpersUrl)) as {
  adminSettings: (database?: string) => pg.ClientConfig;
  contiguousMigrations: () => string;
};
const { migrate } = (await import(migrateUrl)) as { migrate: (c: pg.ClientBase, dir: string) => Promise<{ applied: string[] }> };

const root = new pg.Client(helpers.adminSettings());
await root.connect();
await root.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await root.query(`CREATE DATABASE ${DB}`);
await root.end();

const client = new pg.Client(helpers.adminSettings(DB));
await client.connect();
const r = await migrate(client, helpers.contiguousMigrations());
await client.end();
process.stdout.write(`${DB}: ${String(r.applied.length)} migrations applied\n`);
