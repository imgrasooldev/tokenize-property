import { randomBytes } from "node:crypto";
import type pg from "pg";
import { investor } from "./compliance";

/**
 * S-04 fixtures for the admin tests (migration 0028), written the way the backend writes them:
 * transfer signing policies approved by two operators, a registered deployment, read-model rows as
 * the indexer writes them (registered identities in Pakistan, holdings), trustee register entries,
 * and the token's completed offering (lock-up passed). No personal data exists anywhere.
 */
const A = (n: number): string => `0x${n.toString(16).padStart(40, "0")}`;
export const TRANSFER_TOKEN = A(0x9001);
const REGISTRY = A(0x9002);
const GUARD = A(0x9003);
export const PRICE = 100_000n; // paisa per unit (PKR 1,000)

/** Active transfer.propose/execute/cancel policies, the deployment and the completed offering (once per database). */
export async function transferWorld(su: pg.Client): Promise<void> {
  const known = await su.query("SELECT 1 FROM signer.policies WHERE kind = 'transfer.propose' AND approved_at IS NOT NULL AND retired_at IS NULL");
  if (known.rowCount) return;
  await su.query("SELECT chain.register_deployment('transfer-fixture', 586586, 0, $1::jsonb, NULL)", [
    JSON.stringify({ token: TRANSFER_TOKEN, identityRegistry: REGISTRY, recovery: GUARD }),
  ]);
  const rule = { chainId: 586586, keyRef: "trustee", recoveryGuard: GUARD, token: TRANSFER_TOKEN, identityRegistry: REGISTRY, maxBalance: "100000", maxPerDay: 200, approvals: 0 };
  for (const kind of ["transfer.propose", "transfer.execute", "transfer.cancel"]) {
    const p = await su.query<{ id: string }>("SELECT signer.propose_policy($1, $2::jsonb, 'maker') AS id", [kind, JSON.stringify(rule)]);
    await su.query("SELECT signer.approve_policy($1, 'checker')", [p.rows[0]?.id]);
  }
  // The token's completed offering (lock-up end, minimum and maximum holding, offering price). TEST ONLY: written
  // directly with triggers and foreign keys off, as the backend's transfer tests do.
  await su.query("SET session_replication_role = replica");
  try {
    await su.query(
      `INSERT INTO offering.offerings (property_id, state, price_paisa, min_units, max_units, max_holding_units, register_units, token, completed_at, created_by)
       VALUES (gen_random_uuid(), 'completed', $1, 10, 100000, 100000, 1000000, $2, now() - interval '7 months', 'test-setup')`,
      [PRICE.toString(), TRANSFER_TOKEN],
    );
  } finally {
    await su.query("RESET session_replication_role");
  }
}

export interface Party {
  subjectId: string;
  wallet: string;
}

/** A verified, screened investor whose wallet is registered (Pakistan) and holds `units` (read model and trustee register). */
export async function party(su: pg.Client, units = 0n): Promise<Party> {
  await transferWorld(su);
  const p = await investor(su);
  await su.query("INSERT INTO chain.investors (registry, wallet, identity, country, registered, updated_block) VALUES ($1, $2, $3, 586, true, 1)", [
    REGISTRY,
    p.wallet,
    `0x${randomBytes(20).toString("hex")}`,
  ]);
  if (units > 0n) {
    await su.query("INSERT INTO chain.holdings (token, holder, balance, updated_block) VALUES ($1, $2, $3, 1)", [TRANSFER_TOKEN, p.wallet, units.toString()]);
    await su.query("SELECT trustee.enter($1, $2, $3, 'offering', $4, 'test-setup')", [TRANSFER_TOKEN, p.wallet, units.toString(), `test:${p.wallet}`]);
  }
  return { subjectId: p.subjectId, wallet: p.wallet };
}

/** A desk case opened under a command-line name would be refused (ops_maker needed): cases are opened through the portal. */
export const agreement = (): string => randomBytes(32).toString("hex");
