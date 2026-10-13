import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { officer, type TestOfficer } from "../../db/test/officers.ts";
import { verifyAudit } from "../src/service.ts";
import { finalizedDistribution, freezeRecon, investor, passRecon, rentOwed, token, world, type World } from "./setup.ts";

/**
 * Step 6b (migration 0016): payout batches and reconciliation unfreezes decided through the admin
 * portal's database API. The backend functions decide (bank.decide_payout_batch with the payout gate,
 * recon.decide_unfreeze with its passed-run rule); the portal's role only reaches them through
 * admin.* functions that check session, permission and step-up and bind the officer's name.
 */
let w: World;
let portal: pg.Client;
let checker: TestOfficer;
let maker: TestOfficer;
let compliance: TestOfficer;

beforeAll(async () => {
  w = await world();
  portal = new pg.Client(w.settings);
  await portal.connect();
  // Exactly the rights of the portal's login (member of pt_admin_portal only).
  await portal.query("SET ROLE pt_admin_portal");
  checker = await officer(w.db, "ops.checker.bank", "ops_checker");
  maker = await officer(w.db, "ops.maker.bank", "ops_maker");
  compliance = await officer(w.db, "compliance.bank", "compliance_officer");
}, 180_000);

afterAll(async () => {
  await portal.end();
  await w.drop();
}, 180_000);

async function call<T>(sql: string, params: unknown[]): Promise<T> {
  return (await portal.query<{ r: T }>(sql, params)).rows[0]?.r as T;
}

async function pgCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

type Batch = { status: string; itemsDigest: string; totalPaisa: string; lines: { ibanLast4: string; amountPaisa: string; held: boolean }[]; approveBlockers: string[]; blockers: string[] };
type Result = { ok: boolean; status?: string; error?: string; id?: string };
const batchOf = (o: TestOfficer, id: bigint) => call<Batch>("SELECT admin.payout_batch($1, $2) AS r", [o.sessionHash, id.toString()]);
const decideBatch = (o: TestOfficer, id: bigint, decision: string, digest: string) =>
  call<Result>("SELECT admin.decide_payout_batch($1, $2, $3, 'totals match the finalized distribution', $4) AS r", [o.sessionHash, id.toString(), decision, Buffer.from(digest, "hex")]);

describe("payout batches and unfreezes decided in the portal (Step 6b)", () => {
  it("a frozen gate refuses the approval; maker asks, checker unfreezes after a passed run; the batch is then approved", async () => {
    const t = token();
    const a = await investor(w, "Portal Alpha");
    const b = await investor(w, "Portal Bravo");
    await rentOwed(w, t, 1n, [{ subjectId: a.subjectId, amountPaisa: 60_000n }, { subjectId: b.subjectId, amountPaisa: 40_000n }]);
    await finalizedDistribution(w, t, 1n, 100_000n);
    await passRecon(w);
    const batch = await w.bank.createPayoutBatch({
      token: t,
      distributionId: 1n,
      items: [{ subjectId: a.subjectId, amountPaisa: 60_000n }, { subjectId: b.subjectId, amountPaisa: 40_000n }],
      createdBy: "operator:maker",
    });

    // What the checker sees: lines without names, totals, the digest that the decision is bound to.
    const seen = await batchOf(checker, batch);
    expect(seen).toMatchObject({ status: "created", totalPaisa: "100000", blockers: [], approveBlockers: [] });
    expect(seen.lines.map((l) => l.amountPaisa)).toEqual(["60000", "40000"]);
    expect(JSON.stringify(seen)).not.toMatch(/Portal Alpha|Portal Bravo|PK\d{2}/);

    // Reconciliation freezes payouts: the approval is refused by the bank's own gate check.
    await freezeRecon(w);
    expect((await batchOf(checker, batch)).approveBlockers.join(" ")).toMatch(/blocked by reconciliation/);
    expect(await decideBatch(checker, batch, "approve", seen.itemsDigest)).toMatchObject({ ok: false, error: expect.stringMatching(/blocked by reconciliation/) as unknown });
    expect((await batchOf(checker, batch)).status).toBe("created");
    // An operations maker cannot decide (permission), nor a compliance officer.
    expect(await pgCode(decideBatch(maker, batch, "approve", seen.itemsDigest))).toBe("42501");
    expect(await pgCode(decideBatch(compliance, batch, "approve", seen.itemsDigest))).toBe("42501");

    // Maker asks for the unfreeze; a checker cannot ask (approvals.request), the maker cannot decide.
    expect(await pgCode(call("SELECT admin.request_unfreeze($1, 'cash difference explained by a late bank file') AS r", [checker.sessionHash]))).toBe("42501");
    const asked = await call<Result>("SELECT admin.request_unfreeze($1, 'cash difference explained by a late bank file') AS r", [maker.sessionHash]);
    expect(asked.ok).toBe(true);
    const request = String(asked.id);
    type Unfreeze = { requestedBy: string; freeze: { event: string }; blockers: string[]; approveBlockers: string[] };
    const u = await call<Unfreeze>("SELECT admin.unfreeze_request($1, $2) AS r", [checker.sessionHash, request]);
    expect(u.requestedBy).toBe("ops.maker.bank");
    expect(u.approveBlockers.join(" ")).toMatch(/passed after run/);
    const decideUnfreeze = (o: TestOfficer, freezeEvent: string) =>
      call<Result>("SELECT admin.decide_unfreeze($1, $2, 'approve', 'late bank file imported, difference gone', $3) AS r", [o.sessionHash, request, freezeEvent]);
    expect(await pgCode(decideUnfreeze(maker, u.freeze.event))).toBe("42501");
    expect(await decideUnfreeze(checker, u.freeze.event)).toMatchObject({ ok: false, error: expect.stringMatching(/passed after run/) as unknown });
    await passRecon(w);
    expect(await decideUnfreeze(checker, String(Number(u.freeze.event) + 1000))).toMatchObject({ ok: false, error: expect.stringMatching(/differs/) as unknown });
    expect(await decideUnfreeze(checker, u.freeze.event)).toEqual({ ok: true, status: "approved" });
    const gate = await w.db.query<{ allowed: boolean }>("SELECT allowed FROM recon.payout_gate()");
    expect(gate.rows[0]?.allowed).toBe(true);

    // Now the batch: a stale digest is refused, the right one approved.
    expect(await decideBatch(checker, batch, "approve", "00".repeat(32))).toMatchObject({ ok: false, error: expect.stringMatching(/differs/) as unknown });
    expect(await decideBatch(checker, batch, "approve", seen.itemsDigest)).toEqual({ ok: true, status: "approved" });
    const decided = await w.db.query<{ decided_by: string }>("SELECT decided_by FROM bank.payout_batches WHERE id = $1", [batch.toString()]);
    expect(decided.rows[0]?.decided_by).toBe("ops.checker.bank");
    // Decided once.
    expect(await decideBatch(checker, batch, "reject", seen.itemsDigest)).toEqual({ ok: true, status: "approved" });

    // The inbox shows the sections each role may read.
    const inbox = await call<{ payouts: unknown[] | null; unfreeze: unknown[] | null; property: unknown[] | null; gate: { allowed: boolean } | null }>(
      "SELECT admin.approvals_inbox($1) AS r",
      [checker.sessionHash],
    );
    expect(inbox.gate?.allowed).toBe(true);
    expect(inbox.payouts?.length).toBeGreaterThanOrEqual(1);
    const forCompliance = await call<{ payouts: unknown; property: unknown[] }>("SELECT admin.approvals_inbox($1) AS r", [compliance.sessionHash]);
    expect(forCompliance.payouts).toBeNull();
    expect(Array.isArray(forCompliance.property)).toBe(true);

    expect(await verifyAudit(w.db)).toEqual([]);
    expect((await w.db.query("SELECT * FROM recon.verify_audit()")).rows).toEqual([]);
    expect((await w.db.query("SELECT * FROM admin.verify_audit()")).rows).toEqual([]);
    const actions = await w.db.query<{ action: string; kind: string }>("SELECT action, detail->>'kind' AS kind FROM admin.audit WHERE action LIKE 'approval.%' ORDER BY id");
    expect(actions.rows.map((r) => `${r.action}:${r.kind}`)).toEqual(
      expect.arrayContaining(["approval.refused:payout", "approval.requested:unfreeze", "approval.refused:unfreeze", "approval.decided:unfreeze", "approval.decided:payout"]),
    );
  });

  it("officer names cannot be used outside the portal (command line, services)", async () => {
    await freezeRecon(w);
    await expect(w.db.query("SELECT recon.request_unfreeze('ops.maker.bank', 'pretending to be the maker officer')")).rejects.toThrow(/officer of the admin portal/);
    const t = token();
    const a = await investor(w, "Portal Charlie");
    await rentOwed(w, t, 1n, [{ subjectId: a.subjectId, amountPaisa: 5_000n }]);
    await finalizedDistribution(w, t, 1n, 5_000n);
    await expect(w.bank.createPayoutBatch({ token: t, distributionId: 1n, items: [{ subjectId: a.subjectId, amountPaisa: 5_000n }], createdBy: "ops.checker.bank" })).rejects.toThrow(
      /officer of the admin portal/,
    );
    // Ordinary operator names keep working.
    const id = await w.db.query<{ id: string }>("SELECT recon.request_unfreeze('operator:night-shift', 'cash difference explained by a late bank file') AS id");
    expect(Number(id.rows[0]?.id)).toBeGreaterThan(0);
  });
});
