import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { scratchDatabase } from "../../db/test/helpers.ts";
import { isPayoutKind } from "../src/policy.ts";
import { payoutGateDenial } from "../src/service.ts";

/**
 * The reconciliation payout gate in the signing service (ADR 0007): any payout kind is denied unless
 * recon.payout_gate() allows payouts; other kinds are unaffected; an unreadable gate fails closed.
 */
const MIGRATIONS = fileURLToPath(new URL("../../db/migrations", import.meta.url));

let db: pg.Client;
let drop: () => Promise<void>;

async function finishRun(blocking: boolean): Promise<void> {
  const { rows } = await db.query<{ id: string }>("SELECT recon.start_run('test', 'd', '{}'::jsonb) AS id");
  const findings = blocking ? [{ check: "cash.amount_mismatch", severity: "blocking", subject: "x" }] : [];
  await db.query("SELECT recon.complete_run($1, 'test', 1, $2::jsonb, '{}'::jsonb)", [rows[0]?.id, JSON.stringify(findings)]);
}

async function asSigner<T>(fn: () => Promise<T>, role = "pt_signer"): Promise<T> {
  await db.query("BEGIN");
  try {
    await db.query(`SET LOCAL ROLE ${role}`);
    return await fn();
  } finally {
    await db.query("ROLLBACK");
  }
}

beforeAll(async () => {
  ({ client: db, drop } = await scratchDatabase());
  await migrate(db, MIGRATIONS);
});

afterAll(async () => {
  await drop();
});

describe("payout gate in the signing service", () => {
  it("classifies payout kinds (deny by default for any future payout, rent or distribution kind)", () => {
    for (const k of ["payout.bank_batch", "rent.record_payout", "distribution.publish"]) expect(isPayoutKind(k)).toBe(true);
    for (const k of ["issuance.mint", "registry.register", "payouts", "xpayout.y"]) expect(isPayoutKind(k)).toBe(false);
  });

  it("denies payouts until reconciliation passed, and while frozen; never touches other kinds", async () => {
    expect(await asSigner(() => payoutGateDenial(db, "payout.bank_batch"))).toMatch(/no reconciliation run/);
    await finishRun(false);
    expect(await asSigner(() => payoutGateDenial(db, "payout.bank_batch"))).toBeNull();
    await finishRun(true);
    expect(await asSigner(() => payoutGateDenial(db, "payout.bank_batch"))).toMatch(/frozen/);
    await finishRun(false); // a clean run does not unfreeze (maker-checker only)
    expect(await asSigner(() => payoutGateDenial(db, "rent.record_payout"))).toMatch(/frozen/);
    expect(await asSigner(() => payoutGateDenial(db, "issuance.mint"))).toBeNull();
  });

  it("fails closed when the gate cannot be read", async () => {
    await expect(asSigner(() => payoutGateDenial(db, "payout.bank_batch"), "pt_ledger_reader")).rejects.toThrow(/permission denied/);
  });
});
