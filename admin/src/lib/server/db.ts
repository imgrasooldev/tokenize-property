import pg from "pg";
import { config } from "./config";

/**
 * One pool, logged in as a role that is only a member of pt_admin_portal: no table grants, only
 * EXECUTE on the admin.* functions, which check the officer's session and permission themselves.
 */
let pool: pg.Pool | null = null;

export function db(): pg.Pool {
  pool ??= new pg.Pool({
    ...config.db,
    ssl: config.db.ssl ? { rejectUnauthorized: true } : false,
    application_name: "admin-portal",
    max: 10,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 20_000,
    idle_in_transaction_session_timeout: 10_000,
  });
  return pool;
}

export type DbError = Error & { code?: string };

export function pgCode(e: unknown): string | undefined {
  return e instanceof Error && "code" in e && typeof e.code === "string" ? e.code : undefined;
}

/** Errors the database raises on purpose, with messages written for officers (no internals). */
const EXPECTED = new Set(["42501", "23514", "23505", "02000", "P0002", "PTS01", "PTS02"]);

export function officerMessage(e: unknown): string | null {
  const code = pgCode(e);
  if (code && EXPECTED.has(code) && e instanceof Error) return e.message.slice(0, 300);
  return null;
}
