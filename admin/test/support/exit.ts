import { randomBytes } from "node:crypto";
import type pg from "pg";

/**
 * S-05 fixtures for the admin tests (migration 0027): a token in the read model written the way the
 * indexer writes it (deployment, cursor, a block, mint events and transfers), an exit case and a
 * redemption window opened through the backend's own functions under command-line operator names
 * (never an officer's handle outside the portal).
 */
const hex = (n: number): string => `0x${randomBytes(n).toString("hex")}`;
export const sha64 = (): string => randomBytes(32).toString("hex");
let seq = 0;

/** A token whose holders received their units at block `block` (indexed up to block 50). */
export async function exitToken(su: pg.Client, holders: { wallet: string; units: bigint }[], block = 20): Promise<string> {
  const token = hex(20);
  const deployment = `exit:${token.slice(2, 12)}`;
  const supply = holders.reduce((a, h) => a + h.units, 0n);
  await su.query("INSERT INTO chain.deployments (deployment, chain_id, from_block) VALUES ($1, 586586, 0)", [deployment]);
  await su.query("INSERT INTO chain.tokens (token, deployment, total_supply, updated_block) VALUES ($1, $2, $3, 0)", [token, deployment, supply.toString()]);
  await su.query("INSERT INTO chain.cursors (deployment, block_number, block_hash) VALUES ($1, 50, $2)", [deployment, hex(32)]);
  // Blocks are shared by every deployment in the read model: create ours if it is not there yet.
  await su.query("INSERT INTO chain.blocks (number, hash, parent_hash, block_time) VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING", [block, hex(32), hex(32)]);
  let li = 3_000_000 + ++seq * 1000;
  for (const h of holders) {
    const tx = hex(32);
    await su.query(
      `INSERT INTO chain.events (deployment, block_number, log_index, block_hash, tx_hash, tx_index, address, contract, name, args, topics, data)
       VALUES ($1, $2, $3, (SELECT hash FROM chain.blocks WHERE number = $2), $4, 0, $5, 'token', NULL, NULL, '{}', '0x')`,
      [deployment, block, ++li, tx, token],
    );
    await su.query(
      "INSERT INTO chain.transfers (deployment, block_number, log_index, token, tx_hash, from_addr, to_addr, amount, kind) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'mint')",
      [deployment, block, li, token, tx, `0x${"0".repeat(40)}`, h.wallet, h.units.toString()],
    );
  }
  return token;
}

/** An exit case opened by an operator on the command line (proposed). */
export async function exitCaseFixture(su: pg.Client, token: string, voteRequired = true): Promise<string> {
  const { rows } = await su.query<{ id: string }>(
    "SELECT exit.open_case($1, 'sale proposal received from a qualified buyer for the whole building', 120000000, 110000000, $2, 115000000, $3, 2000000, $4, 'operator:night') AS id",
    [token, sha64(), sha64(), voteRequired],
  );
  return rows[0]?.id ?? "";
}

/** A redemption window proposed by an operator (opens in an hour, closes in two days). */
export async function exitWindowFixture(su: pg.Client, token: string): Promise<string> {
  const { rows } = await su.query<{ id: string }>(
    "SELECT exit.propose_window($1, now() + interval '1 hour', now() + interval '2 days', 100000, $2, 0, 'quarterly redemption window (test)', 'operator:night') AS id",
    [token, sha64()],
  );
  return rows[0]?.id ?? "";
}
