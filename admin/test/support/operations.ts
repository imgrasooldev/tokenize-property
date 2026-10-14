import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";

/**
 * S-03 fixtures for the admin tests (migration 0021), written through the backend's own database
 * functions under command-line operator names (never officer handles): a token in the read model,
 * a bank statement line recorded and approved as rent, a distribution calculated at the record
 * block, a proposed charge, a proposed tax rate and a requested FBR export.
 */
const hex = (n: number): string => `0x${randomBytes(n).toString("hex")}`;
let seq = 0;

export interface OperationsWorld {
  token: string;
  period: string;
  distributionId: string;
  chargeId: string;
  rateId: string;
  exportId: string;
}

async function readModelToken(su: pg.Client, holders: { wallet: string; units: bigint }[]): Promise<string> {
  const token = hex(20);
  const deployment = `test:${token.slice(2, 12)}`;
  await su.query("INSERT INTO chain.deployments (deployment, chain_id, from_block) VALUES ($1, 586586, 0)", [deployment]);
  await su.query("INSERT INTO chain.tokens (token, deployment, total_supply, updated_block) VALUES ($1, $2, 0, 0)", [token, deployment]);
  await su.query("INSERT INTO chain.cursors (deployment, block_number, block_hash) VALUES ($1, 50, $2)", [deployment, hex(32)]);
  const block = 2_000_000 + ++seq;
  // A block of our own (blocks are shared by every deployment in the read model).
  await su.query("INSERT INTO chain.blocks (number, hash, parent_hash, block_time) VALUES ($1, $2, $3, now())", [seq, hex(32), hex(32)]).catch(() => undefined);
  let li = block;
  for (const h of holders) {
    const tx = hex(32);
    await su.query(
      `INSERT INTO chain.events (deployment, block_number, log_index, block_hash, tx_hash, tx_index, address, contract, name, args, topics, data)
       VALUES ($1, $2, $3, (SELECT hash FROM chain.blocks WHERE number = $2), $4, 0, $5, 'token', NULL, NULL, '{}', '0x')`,
      [deployment, seq, ++li, tx, token],
    );
    await su.query(
      "INSERT INTO chain.transfers (deployment, block_number, log_index, token, tx_hash, from_addr, to_addr, amount, kind) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'mint')",
      [deployment, seq, li, token, tx, `0x${"0".repeat(40)}`, h.wallet, h.units.toString()],
    );
  }
  return token;
}

/** Rent arrives on a bank line, recorded by one operator and approved by another. */
async function rent(su: pg.Client, token: string, valueDate: string, paisa: bigint): Promise<void> {
  const account = `TEST-ADM-${randomBytes(4).toString("hex").toUpperCase()}`;
  const ledger = `bank:test-adm-${account.toLowerCase()}`;
  await su.query("SELECT ledger.open_account($1, 'asset', 'PKR')", [ledger]);
  await su.query("SELECT recon.register_bank_account($1, $2, 'test:setup')", [account, ledger]);
  const ref = `RENT${randomBytes(5).toString("hex").toUpperCase()}`;
  const { rows } = await su.query<{ id: string }>("SELECT recon.import_bank_statement('test:import', $1, $2::date, 0, $3, $4::jsonb) AS id", [
    account,
    valueDate,
    paisa.toString(),
    JSON.stringify([{ valueDate, amountPaisa: paisa.toString(), reference: ref, counterparty: "Tenant (test)", balancePaisa: paisa.toString() }]),
  ]);
  const c = await su.query<{ id: string }>("SELECT ops.propose_collection($1, $2, 1, 'monthly rent (test)', 'operator:ali') AS id", [token, rows[0]?.id]);
  await su.query("SELECT ops.decide_collection($1, 'operator:sara', 'approve', 'matches the tenant invoice')", [c.rows[0]?.id]);
}

export async function operationsWorld(su: pg.Client, holders: { wallet: string; units: bigint }[]): Promise<OperationsWorld> {
  const token = await readModelToken(su, holders);
  const period = "2026-09";
  const today = (await su.query<{ d: string }>("SELECT ops.pkt_today()::text AS d")).rows[0]?.d ?? "";
  await rent(su, token, "2026-09-10", 10_000_000n);
  const d = await su.query<{ id: string }>("SELECT ops.calculate_distribution($1, $2, $3::date, $4, 'reit_dividend', 'operator:ali') AS id", [token, period, today, seq]);
  const ch = await su.query<{ id: string }>(
    "SELECT ops.propose_charge($1, '2026-10', 'expense', NULL, 'acme-repairs', 'lift repair, tower B', 2500000, $2, 'operator:ali') AS id",
    [token, createHash("sha256").update(`invoice-${token}`).digest()],
  );
  const effective = (await su.query<{ d: string }>("SELECT (ops.pkt_today() + 1)::text AS d")).rows[0]?.d;
  const r = await su
    .query<{ id: string }>("SELECT tax.propose_rate('spv_dividend', 'filer', 150000, $1::date, 'Finance Act test basis (placeholder)', 'operator:tax-desk') AS id", [effective])
    .catch(async () => su.query<{ id: string }>("SELECT id FROM tax.rates WHERE state = 'proposed' ORDER BY id DESC LIMIT 1"));
  const e = await su.query<{ id: string }>("SELECT tax.request_export($1, '2026-09', '2026-09', 'withholding statement (test)', 'operator:tax-desk') AS id", [token]);
  return { token, period, distributionId: d.rows[0]?.id ?? "", chargeId: ch.rows[0]?.id ?? "", rateId: r.rows[0]?.id ?? "", exportId: e.rows[0]?.id ?? "" };
}
