import { randomBytes } from "node:crypto";
import type pg from "pg";

/**
 * Step 6c fixtures for the admin tests: investors written the way the KYC service writes them
 * (kyc.register_subject with stand-in hashes and sealed bytes, provider checks through
 * kyc.record_check, status derived by kyc.evaluate). No name or CNIC exists anywhere: only the
 * last four digits. A sanctions screening in review opens a KYC case by itself (migration 0019).
 */
let seq = 0;

async function check(su: pg.Client, subject: string, kind: string, outcome: string, reason: string, score: number | null, list: string | null): Promise<void> {
  await su.query("SELECT kyc.record_check($1, $2, $3, 'mock-test', $4, $5, $6::smallint, $7, $8, 'kyc-service')", [
    subject,
    kind,
    outcome,
    `REF-${randomBytes(8).toString("hex")}`,
    reason,
    score,
    list,
    randomBytes(32),
  ]);
}

/** A verified investor with a bound wallet; `screening: "review"` puts them in review instead (a case opens). */
export async function investor(su: pg.Client, opts: { screening?: "pass" | "review" | "pep" } = {}): Promise<{ subjectId: string; wallet: string; last4: string }> {
  const last4 = String(1000 + (++seq % 9000));
  const { rows } = await su.query<{ id: string }>("SELECT kyc.register_subject($1::bytea[], '{1}'::smallint[], $2, $3, $4, 'kyc-service') AS id", [
    [randomBytes(32)],
    randomBytes(32),
    randomBytes(60),
    last4,
  ]);
  const subjectId = rows[0]?.id ?? "";
  await check(su, subjectId, "nadra", "pass", "match", null, null);
  await check(su, subjectId, "liveness", "pass", "live", 93, null);
  const s = opts.screening ?? "pass";
  await check(su, subjectId, "sanctions", s === "pass" ? "pass" : "review", s === "pass" ? "clear" : s === "pep" ? "pep_match" : "possible_match", 80, "mock-2026-10-01");
  await su.query("SELECT kyc.evaluate($1, 'kyc-service')", [subjectId]);
  const wallet = `0x${randomBytes(20).toString("hex")}`;
  if (s === "pass") await su.query("SELECT kyc.bind_wallet($1, $2, 'kyc-service')", [subjectId, wallet]);
  return { subjectId, wallet, last4 };
}

/** Active signing policies for compliance.freeze and compliance.unfreeze (approved by two operators). */
export async function freezePolicies(su: pg.Client): Promise<void> {
  for (const kind of ["compliance.freeze", "compliance.unfreeze"]) {
    const active = await su.query("SELECT 1 FROM signer.policies WHERE kind = $1 AND approved_at IS NOT NULL AND retired_at IS NULL", [kind]);
    if (active.rowCount) continue;
    const rule = { chainId: 586586, keyRef: "ops", freezeGuard: `0x${"f1".padStart(40, "0")}`, token: `0x${"2".padStart(40, "0")}`, maxPerDay: 20, approvals: 0 };
    const p = await su.query<{ id: string }>("SELECT signer.propose_policy($1, $2::jsonb, 'maker') AS id", [kind, JSON.stringify(rule)]);
    await su.query("SELECT signer.approve_policy($1, 'checker')", [p.rows[0]?.id]);
  }
}

export async function caseOf(su: pg.Client, subjectId: string): Promise<string> {
  const { rows } = await su.query<{ id: string }>("SELECT id FROM compliance.kyc_cases WHERE subject_id = $1 ORDER BY id DESC LIMIT 1", [subjectId]);
  return rows[0]?.id ?? "";
}
