import pg from "pg";
import type { Config } from "@pt/config";

export { migrate, type MigrationResult } from "./migrate.ts";

export interface PoolOptions {
  /** Shown in pg_stat_activity and server logs; one per service. */
  applicationName: string;
  max?: number;
}

/**
 * Creates a connection pool with conservative defaults: bounded statement and idle-transaction
 * timeouts so a stuck query cannot hold locks on the ledger indefinitely.
 */
export function createPool(config: Config, { applicationName, max = 10 }: PoolOptions): pg.Pool {
  return new pg.Pool({
    host: config.PG_HOST,
    port: config.PG_PORT,
    database: config.PG_DATABASE,
    user: config.PG_USER,
    password: config.PG_PASSWORD,
    ssl: config.PG_SSL === "require" ? { rejectUnauthorized: true } : false,
    application_name: applicationName,
    max,
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

/** Runs `fn` in a transaction; commits on success, rolls back on any error. */
export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
