/**
 * Applies database migrations.
 *   npm run migrate                 # database from backend/.env.local (property_token)
 *   npm run migrate -- --test       # the test database
 */
import { fileURLToPath } from "node:url";
import { loadConfig, readEnvFile } from "@pt/config";
import pg from "pg";
import { migrate } from "./migrate.ts";

const backendDir = fileURLToPath(new URL("../../../", import.meta.url));
const local = readEnvFile(`${backendDir}.env.local`);
// Migrations run as the admin (schema owner). CI passes PG_ADMIN_* as env vars; locally they come
// from backend/.env.local.
const config = loadConfig({
  ...local,
  ...process.env,
  PG_USER: process.env.PG_ADMIN_USER ?? local.PG_ADMIN_USER,
  PG_PASSWORD: process.env.PG_ADMIN_PASSWORD ?? local.PG_ADMIN_PASSWORD,
  PG_DATABASE: process.argv.includes("--test") ? "property_token_test" : "property_token",
});

const client = new pg.Client({
  host: config.PG_HOST,
  port: config.PG_PORT,
  database: config.PG_DATABASE,
  user: config.PG_USER,
  password: config.PG_PASSWORD,
});
await client.connect();
try {
  const result = await migrate(client, fileURLToPath(new URL("../migrations", import.meta.url)));
  console.log(`${config.PG_DATABASE}: applied ${result.applied.length}, already applied ${result.alreadyApplied.length}`);
  for (const name of result.applied) console.log(`  + ${name}`);
} finally {
  await client.end();
}
