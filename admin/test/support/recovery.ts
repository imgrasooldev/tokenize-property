import { randomBytes } from "node:crypto";
import type pg from "pg";
import { investor } from "./compliance";

/**
 * S-06 fixtures for the admin tests (migration 0020), written the way the backend writes them:
 * signing policies approved by two operators, read-model rows as the indexer writes them, cases
 * opened under command-line names (never an officer's handle outside the portal).
 */
const A = (n: number): string => `0x${n.toString(16).padStart(40, "0")}`;
export const RECOVERY_TOKEN = A(0x8001);
const REGISTRY = A(0x8002);
const FREEZE = A(0x8003);
const GUARD = A(0x8004);

/** A reversal case for a duplicated rent booking (needs only the ledger). */
export async function reversalCase(su: pg.Client): Promise<string> {
  await su.query("SELECT ledger.open_account('income:rent:matrix', 'income', 'PKR')");
  const tag = randomBytes(4).toString("hex");
  const { rows } = await su.query<{ id: string }>("SELECT ledger.post_journal($1, 'rent_received', NULL, $2, 'operator:booking', $3::jsonb) AS id", [
    `tenant:rent:matrix:${tag}`,
    `RAAST-RENT-${tag.toUpperCase()}`,
    JSON.stringify([{ account: "bank:trustee-escrow", amount: "1000" }, { account: "income:rent:matrix", amount: "-1000" }]),
  ]);
  const c = await su.query<{ id: string }>("SELECT recovery.open_reversal($1, 'duplicate_booking', 'rent booked twice by the import job', $2, 'operator:night') AS id", [
    rows[0]?.id,
    randomBytes(32),
  ]);
  return c.rows[0]?.id ?? "";
}

/** Active policies for the six recovery kinds and a registered deployment (once per database). */
export async function recoveryPolicies(su: pg.Client): Promise<void> {
  const known = await su.query("SELECT 1 FROM signer.policies WHERE kind = 'recovery.propose' AND approved_at IS NOT NULL AND retired_at IS NULL");
  if (known.rowCount) return;
  await su.query("SELECT chain.register_deployment('recovery-fixture', 586586, 0, $1::jsonb, NULL)", [
    JSON.stringify({ token: RECOVERY_TOKEN, identityRegistry: REGISTRY, freezeGuard: FREEZE, recovery: GUARD }),
  ]);
  const freeze = { chainId: 586586, keyRef: "ops", freezeGuard: FREEZE, token: RECOVERY_TOKEN, maxPerDay: 20, approvals: 0 };
  const rec = { chainId: 586586, keyRef: "trustee", recoveryGuard: GUARD, token: RECOVERY_TOKEN, identityRegistry: REGISTRY, maxBalance: "100000", maxPerDay: 20, approvals: 0 };
  for (const [kind, rule] of [
    ["recovery.freeze", freeze],
    ["recovery.unfreeze", freeze],
    ["recovery.add_key", { chainId: 586586, identityRegistry: REGISTRY, maxPerDay: 20 }],
    ["recovery.propose", rec],
    ["recovery.execute", rec],
    ["recovery.cancel", rec],
  ] as const) {
    const p = await su.query<{ id: string }>("SELECT signer.propose_policy($1, $2::jsonb, 'maker') AS id", [kind, JSON.stringify(rule)]);
    await su.query("SELECT signer.approve_policy($1, 'checker')", [p.rows[0]?.id]);
  }
}

/** A verified investor holding units of the fixture token, registered in its identity registry. */
export async function holder(su: pg.Client, units: number): Promise<{ subjectId: string; wallet: string }> {
  const p = await investor(su);
  await su.query("INSERT INTO chain.holdings (token, holder, balance, updated_block) VALUES ($1, $2, $3, 1)", [RECOVERY_TOKEN, p.wallet, units]);
  await su.query("INSERT INTO chain.investors (registry, wallet, identity, registered, updated_block) VALUES ($1, $2, $3, true, 1)", [REGISTRY, p.wallet, `0x${randomBytes(20).toString("hex")}`]);
  return p;
}

/** An opened wallet-recovery case (protective freeze enqueued, investor notified). */
export async function walletCase(su: pg.Client): Promise<string> {
  await recoveryPolicies(su);
  const p = await holder(su, 120);
  const { rows } = await su.query<{ id: string }>("SELECT recovery.open_case('wallet_recovery', $1, 'investor reports a compromised wallet key', 'operator:night') AS id", [p.subjectId]);
  return rows[0]?.id ?? "";
}
