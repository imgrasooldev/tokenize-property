import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

/**
 * Demo-only investor store for the prototype (schema `webdemo` in the local database). Production
 * keeps investor records in the backend services with the KYC database isolated (threat D-2).
 */
const REPO_ROOT = join(process.cwd(), "..");

function localDbSettings(): pg.PoolConfig {
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
  return {
    host: env.get("PG_HOST") ?? "127.0.0.1",
    port: Number(env.get("PG_PORT") ?? 5433),
    user: env.get("PG_ADMIN_USER") ?? "pt_admin",
    password: env.get("PG_ADMIN_PASSWORD") ?? "",
    // Tests point this at property_token_test; nothing else sets it.
    database: process.env.WEB_DB_NAME === "property_token_test" ? "property_token_test" : "property_token",
    application_name: "web-prototype",
    max: 10,
    // Fail fast instead of queueing forever when the pool is exhausted.
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
  };
}

const SCHEMA = `
CREATE SCHEMA IF NOT EXISTS webdemo;
CREATE TABLE IF NOT EXISTS webdemo.investors (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona          text UNIQUE CHECK (persona IN ('ALICE', 'BOB')),
  display_name     text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 80),
  cnic_last4       text CHECK (cnic_last4 ~ '^[0-9]{4}$'),
  cnic_hmac        text UNIQUE,
  phone_last3      text CHECK (phone_last3 ~ '^[0-9]{3}$'),
  wallet_address   text NOT NULL UNIQUE CHECK (wallet_address ~ '^0x[0-9a-fA-F]{40}$'),
  wallet_key_enc   bytea,
  identity_address text CHECK (identity_address ~ '^0x[0-9a-fA-F]{40}$'),
  kyc_status       text NOT NULL CHECK (kyc_status IN ('pending', 'verified', 'rejected')),
  kyc_note         text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS webdemo.subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id   uuid NOT NULL UNIQUE,
  investor_id  uuid NOT NULL REFERENCES webdemo.investors (id),
  symbol       text NOT NULL CHECK (symbol ~ '^[A-Z][A-Z0-9]{2,11}$'),
  tokens       bigint NOT NULL CHECK (tokens > 0),
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  bank_ref     text NOT NULL CHECK (bank_ref ~ '^RAAST-DEMO-[0-9A-F]{12}$'),
  ref_id       text NOT NULL UNIQUE CHECK (ref_id ~ '^0x[0-9a-f]{64}$'),
  status       text NOT NULL CHECK (status IN ('paid', 'minting', 'done', 'refunded', 'review')),
  mint_tx      text CHECK (mint_tx ~ '^0x[0-9a-f]{64}$'),
  note         text CHECK (length(note) <= 300),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscriptions_investor ON webdemo.subscriptions (investor_id, created_at DESC);
CREATE TABLE IF NOT EXISTS webdemo.topups (
  id           uuid PRIMARY KEY,
  request_id   uuid NOT NULL UNIQUE,
  investor_id  uuid NOT NULL REFERENCES webdemo.investors (id),
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  bank_ref     text NOT NULL CHECK (bank_ref ~ '^RAAST-DEMO-[0-9A-F]{12}$'),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS webdemo.orders (
  id          uuid PRIMARY KEY,
  request_id  uuid NOT NULL UNIQUE,
  investor_id uuid NOT NULL REFERENCES webdemo.investors (id),
  symbol      text NOT NULL CHECK (symbol ~ '^[A-Z][A-Z0-9]{2,11}$'),
  side        text NOT NULL CHECK (side IN ('buy', 'sell')),
  price_paisa bigint NOT NULL CHECK (price_paisa > 0),
  tokens      bigint NOT NULL CHECK (tokens > 0),
  filled      bigint NOT NULL DEFAULT 0 CHECK (filled >= 0 AND filled <= tokens),
  status      text NOT NULL CHECK (status IN ('open', 'filled', 'cancelled')),
  note        text CHECK (length(note) <= 300),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS orders_book ON webdemo.orders (symbol, side, status, price_paisa, created_at);
CREATE INDEX IF NOT EXISTS orders_investor ON webdemo.orders (investor_id, created_at DESC);
CREATE TABLE IF NOT EXISTS webdemo.trades (
  id          uuid PRIMARY KEY,
  symbol      text NOT NULL,
  buy_order   uuid NOT NULL REFERENCES webdemo.orders (id),
  sell_order  uuid NOT NULL REFERENCES webdemo.orders (id),
  buyer_id    uuid NOT NULL REFERENCES webdemo.investors (id),
  seller_id   uuid NOT NULL REFERENCES webdemo.investors (id),
  price_paisa bigint NOT NULL CHECK (price_paisa > 0),
  tokens      bigint NOT NULL CHECK (tokens > 0),
  status      text NOT NULL CHECK (status IN ('settling', 'settled', 'failed', 'review')),
  transfer_tx text CHECK (transfer_tx ~ '^0x[0-9a-f]{64}$'),
  note        text CHECK (length(note) <= 300),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (buyer_id <> seller_id)
);
CREATE INDEX IF NOT EXISTS trades_symbol ON webdemo.trades (symbol, status, created_at);
-- Recorded before broadcast, so an interrupted send can be resolved from the chain later.
ALTER TABLE webdemo.subscriptions ADD COLUMN IF NOT EXISTS mint_nonce integer CHECK (mint_nonce >= 0);
ALTER TABLE webdemo.subscriptions ADD COLUMN IF NOT EXISTS mint_from text CHECK (mint_from ~ '^0x[0-9a-fA-F]{40}$');
ALTER TABLE webdemo.trades ADD COLUMN IF NOT EXISTS transfer_nonce integer CHECK (transfer_nonce >= 0);`;

let pool: pg.Pool | null = null;
let lockPool: pg.Pool | null = null;

/**
 * Runs fn while holding a cross-process lock for one signing address, so two processes (website,
 * demo script, tests) never pick the same nonce. The lock lives in the `postgres` database, which
 * every process can reach whichever application database it uses.
 */
export async function withSignerLock<T>(address: string, fn: () => Promise<T>): Promise<T> {
  lockPool ??= new pg.Pool({ ...localDbSettings(), database: "postgres", max: 4, application_name: "web-signer-lock" });
  const client = await lockPool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1, hashtext($2))", [586_586_040, address.toLowerCase()]);
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1, hashtext($2))", [586_586_040, address.toLowerCase()]);
    }
  } finally {
    client.release();
  }
}
let ready: Promise<void> | null = null;

export async function db(): Promise<pg.Pool> {
  pool ??= new pg.Pool(localDbSettings());
  ready ??= pool.query(SCHEMA).then(() => undefined);
  await ready;
  return pool;
}

export interface InvestorRow {
  id: string;
  persona: string | null;
  display_name: string;
  cnic_last4: string | null;
  phone_last3: string | null;
  wallet_address: `0x${string}`;
  wallet_key_enc: Buffer | null;
  identity_address: `0x${string}` | null;
  kyc_status: "pending" | "verified" | "rejected";
  kyc_note: string | null;
  created_at: Date;
}

export async function investorById(id: string): Promise<InvestorRow | null> {
  const { rows } = await (await db()).query<InvestorRow>("SELECT * FROM webdemo.investors WHERE id = $1", [id]);
  return rows[0] ?? null;
}
