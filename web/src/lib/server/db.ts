import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

/**
 * Demo-only investor store for the prototype (schema `webdemo` in the local database). Production
 * keeps investor records in the backend services with the KYC database isolated (threat D-2).
 */
const REPO_ROOT = join(process.cwd(), "..");

let backendEnvCache: Map<string, string> | null = null;

/**
 * Settings shared with the backend services (backend/.env.local, git-ignored): database
 * connection and the website's client secrets for the signing and KYC services. Read once.
 */
export function backendEnv(): Map<string, string> {
  if (backendEnvCache) return backendEnvCache;
  const file = join(REPO_ROOT, "backend", ".env.local");
  const env = new Map<string, string>();
  // Fixed path inside the repository.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (existsSync(file)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq > 0 && !line.startsWith("#")) env.set(line.slice(0, eq), line.slice(eq + 1));
    }
  }
  backendEnvCache = env;
  return env;
}

/**
 * The website connects as its OWN least-privilege role (migration 0012, W-5: member of pt_web
 * only), never as the database admin. `npm run db:web-role` (backend) creates it and writes
 * WEB_PG_USER / WEB_PG_PASSWORD to backend/.env.local. Without them the website refuses to start
 * its database pool rather than fall back to the admin.
 */
function testDatabase(name: string | undefined): string | null {
  if (name === "property_token_test") return name;
  if (process.env.VITEST === "true" && name !== undefined && /^pt_scratch_[0-9]{1,16}_[0-9]{1,8}$/.test(name)) return name;
  return null;
}

function localDbSettings(): pg.PoolConfig {
  const env = backendEnv();
  const user = env.get("WEB_PG_USER");
  const password = env.get("WEB_PG_PASSWORD");
  if (!user || !password) throw new Error("The website's database role is not set up. Run `npm run migrate` and `npm run db:web-role` in backend/.");
  if (user === (env.get("PG_ADMIN_USER") ?? "pt_admin")) throw new Error("WEB_PG_USER must not be the database admin.");
  return {
    host: env.get("PG_HOST") ?? "127.0.0.1",
    port: Number(env.get("PG_PORT") ?? 5433),
    user,
    password,
    // Tests point this at property_token_test, or (vitest only) at a throw-away database made by the
    // backend's test helpers (pt_scratch_<n>_<n>); nothing else sets it.
    database: testDatabase(process.env.WEB_DB_NAME) ?? "property_token",
    application_name: "web-prototype",
    // Page reads, the live feed snapshot (4 parallel queries), the matcher and the settlement
    // follower (which holds its lock connection during a pass) share this pool.
    max: 20,
    // Fail fast instead of queueing forever when the pool is exhausted.
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
  };
}

let pool: pg.Pool | null = null;
let backgroundPool: pg.Pool | null = null;
const poolScope = new AsyncLocalStorage<"background">();

/**
 * The website's pool. Its schema (webdemo) is created by migration 0012; the website runs no DDL.
 * Work started by runInBackgroundPool (the settlement follower) gets its own small pool, so
 * settlement keeps moving even when page traffic uses every connection of the main pool.
 */
export function db(): Promise<pg.Pool> {
  try {
    if (poolScope.getStore() === "background") {
      backgroundPool ??= new pg.Pool({ ...localDbSettings(), max: 6, application_name: "web-follower" });
      return Promise.resolve(backgroundPool);
    }
    pool ??= new pg.Pool(localDbSettings());
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
  return Promise.resolve(pool);
}

/** Runs fn with db() and tx() on the background pool (settlement follower). */
export function runInBackgroundPool<T>(fn: () => Promise<T>): Promise<T> {
  return poolScope.run("background", fn);
}

/** Runs fn in one database transaction. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export type OnboardStep = "identity" | "claims" | "register" | "done" | "failed";

export interface InvestorRow {
  id: string;
  persona: string | null;
  display_name: string;
  cnic_last4: string | null;
  phone_last3: string | null;
  wallet_address: `0x${string}`;
  /** Legacy (before Step 5h): the website no longer holds any key; moved by signer:import-web-wallets. */
  wallet_key_enc: Buffer | null;
  identity_address: `0x${string}` | null;
  kyc_status: "pending" | "verified" | "rejected";
  kyc_note: string | null;
  kyc_subject: string | null;
  onboard_step: OnboardStep | null;
  onboard_attempt: number;
  created_at: Date;
}

export async function investorById(id: string): Promise<InvestorRow | null> {
  const { rows } = await (await db()).query<InvestorRow>("SELECT * FROM webdemo.investors WHERE id = $1", [id]);
  return rows[0] ?? null;
}
