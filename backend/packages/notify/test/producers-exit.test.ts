import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExitService } from "../../exit/src/service.ts";
import { burned, createWorld, investor, toRedeeming, type Investor, type World } from "../../exit/test/world.ts";
import { verifyAudit } from "../src/service.ts";
import { kindsOf, notesOf, producerFailureCount } from "./helpers.ts";

/**
 * Migration 0030 producers of S-05 (exit, migration 0027) on the exit test world: officers are asked
 * for every decision by capacity (never the proposer); holders hear about the sale's milestones, their
 * final distribution and the redemption of their units, once each; nothing is said about the
 * committee's own deliberation before the sale is agreed.
 */

let w: World;
let A: Investor;
let B: Investor;
let r: Awaited<ReturnType<typeof toRedeeming>>;

beforeAll(async () => {
  w = await createWorld();
  // As the exit tests do (local test only): placeholder tax rates, no notice periods.
  await w.su.query("UPDATE ops.settings SET value = 'true' WHERE key = 'allow_placeholder_rates'");
  await w.su.query("UPDATE exit.settings SET value = '0' WHERE key IN ('vote_notice_days', 'record_notice_days')");
  A = await investor(w);
  B = await investor(w);
  r = await toRedeeming(w, [{ inv: A, units: 700n }, { inv: B, units: 300n }], "after_finalization");
}, 300_000);
afterAll(async () => {
  await w.drop();
}, 120_000);

describe("exit producers (S-05)", () => {
  it("every exit decision waits for officers of its capacities, never for the maker who proposed it", async () => {
    const { rows } = await w.su.query<{ id: string; code: string }>("SELECT id::text, code FROM exit.decisions WHERE case_id = $1 ORDER BY id", [r.caseId]);
    expect(rows.map((x) => x.code)).toEqual(["X3", "X7", "X9", "X11", "X12"]);
    const waiting = async (handle: string, id: string) => (await notesOf(w.pool, "officer", handle, "officer.action_waiting")).filter((n) => n.key.startsWith(`exit:decision:${id}:`));
    const x3 = rows[0]?.id ?? "";
    expect((await waiting(w.officers.checker.handle, x3)).map((n) => n.params)).toEqual([{ queue: "exit_decision", reference: `EX-${x3}` }]);
    expect(await waiting(w.officers.compliance.handle, x3)).toHaveLength(1);
    expect(await waiting(w.officers.trustee.handle, x3)).toHaveLength(0);
    expect(await waiting(w.officers.maker.handle, x3)).toHaveLength(0);
    const x11 = rows[3]?.id ?? "";
    expect(await waiting(w.officers.legal.handle, x11)).toHaveLength(1);
    expect(await waiting(w.officers.checker.handle, x11)).toHaveLength(0);
  });

  it("holders hear 'sale agreed' and 'sale completed' once each, and their net final distribution once", async () => {
    for (const inv of [A, B]) {
      const updates = await notesOf(w.pool, "investor", inv.subjectId, "exit.update");
      expect(updates.map((n) => n.params.stage)).toEqual(["sale_agreed", "sale_completed"]);
      const credited = await notesOf(w.pool, "investor", inv.subjectId, "exit.final_credited");
      expect(credited).toHaveLength(1);
      expect(BigInt(credited[0]?.params.amount_paisa ?? "0")).toBeGreaterThan(0n);
    }
  });

  it("a redemption burn seen on chain tells the holder once, however often the exit job runs", async () => {
    const svc = new ExitService(w.pool);
    const lines = (await w.pool.query<{ wallet: string; units: string; ref_id: string }>("SELECT wallet, units::text, ref_id FROM exit.redemption_lines WHERE redemption_id = $1", [r.redemptionId])).rows;
    for (const l of lines) await burned(w, r.t, l.wallet, BigInt(l.units), l.ref_id, 20);
    await svc.tick("exit-worker");
    await svc.tick("exit-worker");
    const seen = Number((await w.pool.query<{ n: string }>("SELECT count(*) AS n FROM exit.burns_seen")).rows[0]?.n);
    expect(seen).toBe(2);
    const a = await notesOf(w.pool, "investor", A.subjectId, "exit.units_redeemed");
    expect(a.map((n) => n.params.units)).toEqual(["700"]);
    expect(await kindsOf(w.pool, B.subjectId)).toContain("exit.units_redeemed");
  });

  it("no producer failed and the notify audit chain verifies", async () => {
    expect(await producerFailureCount(w.pool)).toBe(0);
    expect(await verifyAudit(w.pool)).toEqual([]);
  });
});
