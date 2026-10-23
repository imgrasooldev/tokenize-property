import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { migrate } from "../../db/src/migrate.ts";
import { contiguousMigrations, scratchDatabase, serviceLogin } from "../../db/test/helpers.ts";
import { officer } from "../../db/test/officers.ts";
import { KycService, mockProviders, Peppers } from "@pt/kyc";
import { buildStatement, importStatement, registerBankAccount } from "@pt/recon";
import { OpsService } from "../src/service.ts";

/**
 * A scratch database with every migration and helpers that build what S-03 operations need: a
 * token in the read model (deployment, cursor, blocks, transfer events), KYC subjects with bound
 * wallets (through the real KYC service and mock providers), bank statements imported into
 * reconciliation, and the operator steps (maker and checker under command-line names, never
 * officer handles). Connections for the database roles of 0021 use the role as a startup option.
 */
export interface World {
  su: pg.Client;
  settings: pg.ClientConfig;
  /** Superuser pool (setup). */
  pool: pg.Pool;
  /** Logged in exactly with the rights of the operations service. */
  ops: pg.Pool;
  /** The tax service as in production: a login in pt_svc_tax (T-012, migration 0029). */
  taxdb: pg.Pool;
  peppers: Peppers;
  kyc: KycService;
  drop: () => Promise<void>;
}

export async function createWorld(): Promise<World> {
  const { client: su, settings, drop } = await scratchDatabase();
  await migrate(su, contiguousMigrations());
  const pool = new pg.Pool({ ...settings, max: 4 });
  const ops = new pg.Pool({ ...settings, max: 3, options: "-c role=pt_ops_operator" });
  const taxLogin = await serviceLogin("tax", String(settings.database));
  const taxdb = new pg.Pool({ ...taxLogin.settings, max: 3 });
  const peppers = Peppers.of([{ version: 1, key: randomBytes(32) }]);
  const kyc = new KycService(pool, mockProviders(), peppers, randomBytes(32));
  await registerBankAccount(pool, "TRUSTEE-ESCROW", "bank:trustee-escrow", "test:setup");
  return {
    su,
    settings,
    pool,
    ops,
    taxdb,
    peppers,
    kyc,
    drop: async () => {
      await ops.end();
      await taxdb.end();
      await pool.end();
      await drop();
      await taxLogin.drop();
    },
  };
}

export const address = (): string => `0x${randomBytes(20).toString("hex")}`;
const hash32 = (): string => `0x${randomBytes(32).toString("hex")}`;
export const evidence = (label: string): string => createHash("sha256").update(label).digest("hex");

// ------------------------------------------------------------------ read model

export interface TestToken {
  token: string;
  deployment: string;
  registry: string;
}

let logIndex = 0;

/** A token in the read model with its deployment and cursor at `head`. */
export async function token(w: World, head = 100): Promise<TestToken> {
  const t = address();
  const deployment = `test:${t.slice(2, 12)}`;
  await w.su.query("INSERT INTO chain.deployments (deployment, chain_id, from_block) VALUES ($1, 586586, 0)", [deployment]);
  await w.su.query("INSERT INTO chain.tokens (token, deployment, total_supply, updated_block) VALUES ($1, $2, 0, 0)", [t, deployment]);
  await w.su.query("INSERT INTO chain.cursors (deployment, block_number, block_hash) VALUES ($1, $2, $3)", [deployment, head, hash32()]);
  return { token: t, deployment, registry: address() };
}

async function block(w: World, n: number): Promise<string> {
  const { rows } = await w.su.query<{ hash: string }>("SELECT hash FROM chain.blocks WHERE number = $1", [n]);
  if (rows[0]) return rows[0].hash;
  const h = hash32();
  await w.su.query("INSERT INTO chain.blocks (number, hash, parent_hash, block_time) VALUES ($1, $2, $3, now())", [n, h, hash32()]);
  return h;
}

/** One Transfer event in the read model (from 0x0 = mint). */
export async function transfer(w: World, t: TestToken, from: string, to: string, amount: bigint, at: number): Promise<void> {
  const bh = await block(w, at);
  const li = ++logIndex;
  const tx = hash32();
  await w.su.query(
    `INSERT INTO chain.events (deployment, block_number, log_index, block_hash, tx_hash, tx_index, address, contract, name, args, topics, data)
     VALUES ($1, $2, $3, $4, $5, 0, $6, 'token', NULL, NULL, '{}', '0x')`,
    [t.deployment, at, li, bh, tx, t.token],
  );
  const kind = from === ZERO ? "mint" : to === ZERO ? "burn" : "transfer";
  await w.su.query(
    "INSERT INTO chain.transfers (deployment, block_number, log_index, token, tx_hash, from_addr, to_addr, amount, kind) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [t.deployment, at, li, t.token, tx, from, to, amount.toString(), kind],
  );
}
export const ZERO = "0x0000000000000000000000000000000000000000";

/** The read model's view of a distribution (written by the indexer in production). */
export async function chainDistribution(
  w: World,
  t: TestToken,
  id: number,
  d: { recordBlock: number; root: string; total: bigint; statementHash: string; status: string },
): Promise<void> {
  await w.su.query(
    `INSERT INTO chain.distributions (registry, id, token, record_block, merkle_root, total_paisa, statement_hash, status, published_block, updated_block)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 1)`,
    [t.registry, id, t.token, d.recordBlock, d.root, d.total.toString(), d.statementHash, d.status],
  );
}

// ------------------------------------------------------------------ investors

let seq = Math.floor(Math.random() * 400_000);

/** A fresh, valid test CNIC whose last digit is chosen (mock NADRA passes 1-7). */
export function cnic(last: number): string {
  seq++;
  return `${String(10000 + (seq % 89999)).padStart(5, "0")}${String(1_000_000 + seq).slice(-7)}${String(last)}`;
}

export interface Investor {
  subjectId: string;
  wallet: string;
  cnic: string;
}

export async function investor(w: World, last = 1): Promise<Investor> {
  const c = cnic(last);
  const wallet = address();
  const r = await w.kyc.onboard({ cnic: c, fullName: "Test Investor", livenessSessionId: `sess-ops-${randomBytes(4).toString("hex")}`, wallet });
  if (r.status !== "verified") throw new Error(`test investor not verified: ${r.reason}`);
  return { subjectId: r.subjectId, wallet, cnic: c };
}

/** An ATL result recorded for a subject (as the tax service records it). */
export async function filerCheck(w: World, subject: string, status: "filer" | "non_filer" | "unavailable", asOf: string | null): Promise<string> {
  const { rows } = await w.taxdb.query<{ id: string }>("SELECT tax.record_filer_check($1, $2, $3, 'mock-atl', $4, 'test:atl')::text AS id", [
    subject,
    status,
    asOf,
    createHash("sha256").update(`${subject}:${status}`).digest(),
  ]);
  return rows[0]?.id ?? "";
}

// ------------------------------------------------------------------ bank and operations

let accounts = 0;

/**
 * Imports one bank statement with these credits on a fresh account registered for reconciliation
 * (its own ledger asset account), on the given value date. Returns the statement id.
 */
export async function bankLines(w: World, valueDate: string, lines: { amount: bigint; reference: string }[]): Promise<bigint> {
  const account = `TEST-OPS-${String(++accounts)}-${randomBytes(3).toString("hex").toUpperCase()}`;
  const ledger = `bank:test-ops-${account.toLowerCase()}`;
  await w.pool.query("SELECT ledger.open_account($1, 'asset', 'PKR')", [ledger]);
  await registerBankAccount(w.pool, account, ledger, "test:setup");
  const st = buildStatement(account, valueDate, 0n, lines.map((l) => ({ valueDate, amountPaisa: l.amount, reference: l.reference, counterparty: "Tenant (test)" })));
  return importStatement(w.pool, st, "test:import");
}

const ref = (): string => `RENT${randomBytes(6).toString("hex").toUpperCase()}`;

/** A collection recorded by one operator and approved by another (OT-1). */
export async function collect(w: World, t: TestToken, valueDate: string, amount: bigint): Promise<string> {
  const st = await bankLines(w, valueDate, [{ amount, reference: ref() }]);
  const { rows } = await w.ops.query<{ id: string }>("SELECT ops.propose_collection($1, $2, 1, 'monthly rent received', 'operator:ali')::text AS id", [t.token, st]);
  const id = rows[0]?.id ?? "";
  await w.ops.query("SELECT ops.decide_collection($1, 'operator:sara', 'approve', 'matches the tenant invoice')", [id]);
  return id;
}

export type ChargeKind = "expense" | "fee" | "reserve_contribution" | "reserve_release";

export async function proposeCharge(
  w: World,
  t: TestToken,
  period: string,
  kind: ChargeKind,
  amount: bigint,
  o: { feeType?: string; payee?: string; actor?: string } = {},
): Promise<string> {
  const { rows } = await w.ops.query<{ id: string }>(
    "SELECT ops.propose_charge($1, $2, $3, $4, $5, $6, $7, decode($8, 'hex'), $9)::text AS id",
    [t.token, period, kind, o.feeType ?? null, o.payee ?? (kind === "expense" || kind === "fee" ? "acme-services" : null), `${kind} for ${period}`, amount.toString(), evidence(`${kind}${period}${amount.toString()}`), o.actor ?? "operator:ali"],
  );
  return rows[0]?.id ?? "";
}

export async function charge(w: World, t: TestToken, period: string, kind: ChargeKind, amount: bigint, o: { feeType?: string; payee?: string } = {}): Promise<string> {
  const id = await proposeCharge(w, t, period, kind, amount, o);
  await w.ops.query("SELECT ops.decide_charge($1, 'operator:sara', 'approve', 'evidence checked against the budget')", [id]);
  return id;
}

export async function calculate(w: World, t: TestToken, period: string, recordDate: string, recordBlock: number, incomeType = "reit_dividend"): Promise<string> {
  const { rows } = await w.ops.query<{ id: string }>("SELECT ops.calculate_distribution($1, $2, $3, $4, $5, 'operator:ali')::text AS id", [
    t.token,
    period,
    recordDate,
    recordBlock,
    incomeType,
  ]);
  return rows[0]?.id ?? "";
}

export async function allowPlaceholders(w: World, on: boolean): Promise<void> {
  await w.su.query("UPDATE ops.settings SET value = $1::jsonb WHERE key = 'allow_placeholder_rates'", [on ? "true" : "false"]);
}

/** Calculation -> statement attached -> approved -> finalized on chain (read model) -> booked. Returns the on-chain id. */
export async function publishAndBook(w: World, t: TestToken, calcId: string, onchainId: number): Promise<{ statementHash: string; net: bigint; wht: bigint }> {
  const docs = await new OpsService(w.ops).attach(calcId, "operator:omar");
  await trusteePrecheck(w, calcId);
  await w.ops.query("SELECT ops.decide_distribution($1, 'operator:sara', 'approve', 'recomputed and matches the statement')", [calcId]);
  const { rows } = await w.pool.query<{ record_block: string; sum_net: string; sum_wht: string }>(
    "SELECT record_block::text, sum_net::text, sum_wht::text FROM ops.distributions WHERE id = $1",
    [calcId],
  );
  const r = rows[0];
  if (!r) throw new Error("no calculation");
  await chainDistribution(w, t, onchainId, { recordBlock: Number(r.record_block), root: docs.root, total: BigInt(r.sum_net), statementHash: docs.statementHash, status: "finalized" });
  await w.ops.query("SELECT ops.book_distribution($1, $2, $3, 'operator:omar')", [calcId, t.registry, onchainId]);
  return { statementHash: docs.statementHash, net: BigInt(r.sum_net), wht: BigInt(r.sum_wht) };
}

/**
 * Step 6d (migration 0023, S-03 D4): the trustee's pre-check of an attached calculation, given as the
 * trustee portal gives it (a signed-in trustee officer, fresh step-up, digest, recomputed root).
 */
export async function trusteePrecheck(w: World, calcId: string, decision: "approve" | "reject" = "approve"): Promise<{ ok: boolean; status?: string; error?: string }> {
  const o = await officer(w.su, "trustee.tax.test", "trustee_officer");
  const { rows } = await w.su.query<{ digest: Buffer; root: string }>("SELECT ops.distribution_digest(id) AS digest, merkle_root AS root FROM ops.distributions WHERE id = $1", [calcId]);
  const r = await w.su.query<{ r: { ok: boolean; status?: string; error?: string } }>(
    "SELECT admin.precheck_distribution($1, $2, $3, 'root recomputed from the record block and the statement', $4, $5) AS r",
    [o.sessionHash, calcId, decision, rows[0]?.digest, decision === "approve" ? rows[0]?.root : null],
  );
  return r.rows[0]?.r ?? { ok: false };
}

/** Step 6d (OP-21): the trustee's decision on a charge above the operations limit, through the portal function. */
export async function trusteeDecideCharge(w: World, chargeId: string, decision: "approve" | "reject" = "approve"): Promise<{ ok: boolean; status?: string; error?: string }> {
  const o = await officer(w.su, "trustee.tax.test", "trustee_officer");
  const { rows } = await w.su.query<{ digest: Buffer }>("SELECT ops.charge_digest($1) AS digest", [chargeId]);
  const r = await w.su.query<{ r: { ok: boolean; status?: string; error?: string } }>(
    "SELECT admin.decide_trustee_charge($1, $2, $3, 'invoice and budget line checked by the trustee', $4) AS r",
    [o.sessionHash, chargeId, decision, rows[0]?.digest],
  );
  return r.rows[0]?.r ?? { ok: false };
}

export async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

export async function message(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function balance(w: World, account: string): Promise<bigint> {
  const { rows } = await w.pool.query<{ b: string | null }>(
    "SELECT b.balance::text AS b FROM ledger.accounts a JOIN ledger.account_balances b ON b.account_id = a.id WHERE a.code = $1",
    [account],
  );
  return BigInt(rows[0]?.b ?? "0");
}
