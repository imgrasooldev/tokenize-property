import { randomBytes } from "node:crypto";
import type pg from "pg";

/**
 * Step 6d fixtures (migration 0023): read-model rows written the way the indexer writes them (a
 * registered deployment, holdings, blocks and published distributions). Wallets and hashes only;
 * no personal data exists anywhere.
 */
export const hex = (bytes: number): string => `0x${randomBytes(bytes).toString("hex")}`;

export interface TestToken {
  deployment: string;
  token: string;
  registry: string;
}

let blockNo = 1000;

/** A deployment with its token and DistributionRegistry, supply and cap set as the indexer would. */
export async function readModelToken(su: pg.Client, opts: { supply?: bigint; cap?: bigint } = {}): Promise<TestToken> {
  const t: TestToken = { deployment: `dep-${randomBytes(4).toString("hex")}`, token: hex(20), registry: hex(20) };
  await su.query("SELECT chain.register_deployment($1, 586586, 0, $2::jsonb, NULL)", [
    t.deployment,
    JSON.stringify({ token: t.token, issuance: hex(20), identityRegistry: hex(20), distributions: t.registry }),
  ]);
  await su.query("UPDATE chain.tokens SET total_supply = $2, trustee_cap = $3 WHERE token = $1", [t.token, String(opts.supply ?? 0n), String(opts.cap ?? 1_000_000n)]);
  return t;
}

/** A holder balance in the read model. */
export async function holding(su: pg.Client, t: TestToken, wallet: string, balance: bigint): Promise<void> {
  await su.query(
    `INSERT INTO chain.holdings (token, holder, balance, updated_block) VALUES ($1, $2, $3, 1)
     ON CONFLICT (token, holder) DO UPDATE SET balance = EXCLUDED.balance`,
    [t.token, wallet, balance.toString()],
  );
}

/** A distribution in the read model, published `hoursAgo` hours ago (block time), with the given on-chain status. */
export async function distribution(su: pg.Client, t: TestToken, id: number, opts: { hoursAgo?: number; status?: string } = {}): Promise<{ id: number; root: string }> {
  const n = ++blockNo;
  await su.query("INSERT INTO chain.blocks (number, hash, parent_hash, block_time) VALUES ($1, $2, $3, now() - make_interval(hours => $4))", [
    n,
    hex(32),
    hex(32),
    opts.hoursAgo ?? 1,
  ]);
  const root = hex(32);
  await su.query(
    `INSERT INTO chain.distributions (registry, id, token, record_block, merkle_root, total_paisa, statement_hash, status, published_block, updated_block)
     VALUES ($1, $2, $3, $4, $5, 1500000, $6, $7, $8, $8)`,
    [t.registry, id, t.token, n - 1, root, hex(32), opts.status ?? "published", n],
  );
  return { id, root };
}
