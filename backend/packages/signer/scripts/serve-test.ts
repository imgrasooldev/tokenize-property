/**
 * TEST ONLY: a real signing service (SignerService + HTTP API) for the admin portal's HTTP matrix and
 * end-to-end tests (Step 6b). It differs from `npm run signer` only where a test needs it:
 *  - a temporary keystore with one freshly generated "issuance" key (never a dev or real key);
 *  - a chain reader with fixed facts (no node needed): the recipient is verified, the token unpaused,
 *    the cap far away, every simulation succeeds;
 *  - an issuance.mint policy (approval above 10,000 tokens, two approvals) if none is active.
 * Refuses production and any database other than the portal's test databases.
 *
 * Environment: PG_HOST, PG_PORT, PG_ADMIN_USER, PG_ADMIN_PASSWORD, PG_DATABASE (pt_admin_e2e or
 * pt_scratch_admin_*), SIGNER_PORT, SIGNER_CLIENT_SECRET_ADMIN, SIGNER_CLIENT_SECRET_OUTBOX.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secretFromEnv } from "@pt/http-auth";
import pg from "pg";
import { generatePrivateKey } from "viem/accounts";
import { ADMIN_SCOPE, createSignerServer, OUTBOX_SCOPE } from "../src/http.ts";
import { FileKeystore, writeKeyFile } from "../src/keystore.ts";
import { SignerService, type ChainReader } from "../src/service.ts";

const env = process.env as Record<string, string | undefined>;
const database = env.PG_DATABASE ?? "";
if (env.NODE_ENV === "production") throw new Error("serve-test is for tests only");
if (!/^(pt_admin_e2e|pt_scratch_admin_[0-9_]{1,40})$/.test(database)) throw new Error(`serve-test refuses database ${database}: test databases of the admin portal only`);

const A = (n: number): `0x${string}` => `0x${n.toString(16).padStart(40, "0")}`;
const chain: ChainReader = {
  chainId: () => Promise.resolve(586586),
  pendingNonce: () => Promise.resolve(0n),
  simulate: () => Promise.resolve(),
  mintFacts: () => Promise.resolve({ recipientVerified: true, supply: 0n, cap: 1_000_000_000n, paused: false }),
  txState: () => Promise.resolve("pending"),
  isFrozen: () => Promise.resolve(false),
  distribution: () => Promise.resolve({ status: "none", token: A(2) }),
};

const pool = new pg.Pool({
  host: env.PG_HOST ?? "127.0.0.1",
  port: Number(env.PG_PORT ?? 5433),
  user: env.PG_ADMIN_USER ?? "pt_admin",
  password: env.PG_ADMIN_PASSWORD,
  database,
  max: 4,
  application_name: "signer-test",
});
const passphrase = `test-only-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}-keystore`;
const dir = await mkdtemp(join(tmpdir(), "pt-signer-test-"));
await writeKeyFile(dir, "issuance", generatePrivateKey(), passphrase);
const keys = await FileKeystore.open(dir, passphrase);
await pool.query("INSERT INTO signer.keys (key_ref, address, purpose) VALUES ('issuance', $1, 'test signer (serve-test)') ON CONFLICT (key_ref) DO NOTHING", [keys.address("issuance")]);
const stored = await pool.query<{ address: string }>("SELECT address FROM signer.keys WHERE key_ref = 'issuance'");
if (stored.rows[0]?.address !== keys.address("issuance")) throw new Error("this database already holds another issuance key: use a fresh test database");
const active = await pool.query("SELECT 1 FROM signer.policies WHERE kind = 'issuance.mint' AND approved_at IS NOT NULL AND retired_at IS NULL");
if (active.rowCount === 0) {
  const rule = { chainId: 586586, keyRef: "issuance", issuance: A(1), token: A(2), identityRegistry: A(3), maxPerCommand: "100000", maxPerDay: "1000000", approvalAbove: "10000", approvals: 2 };
  const { rows } = await pool.query<{ id: string }>("SELECT signer.propose_policy('issuance.mint', $1::jsonb, 'test-maker') AS id", [JSON.stringify(rule)]);
  await pool.query("SELECT signer.approve_policy($1, 'test-checker')", [rows[0]?.id]);
}

const service = new SignerService(pool, keys, chain);
const clients = [
  { id: "outbox-worker", secret: secretFromEnv(env, "SIGNER_CLIENT_SECRET_OUTBOX"), scope: OUTBOX_SCOPE },
  { id: "admin-portal", secret: secretFromEnv(env, "SIGNER_CLIENT_SECRET_ADMIN"), scope: ADMIN_SCOPE },
];
const port = Number(env.SIGNER_PORT ?? 4999);
createSignerServer(service, clients).listen(port, "127.0.0.1", () => {
  console.log(`test signer on 127.0.0.1:${String(port)} (database ${database})`);
});
