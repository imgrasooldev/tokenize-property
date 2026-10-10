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
    database: "property_token",
    application_name: "web-prototype",
    max: 5,
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
);`;

let pool: pg.Pool | null = null;
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
