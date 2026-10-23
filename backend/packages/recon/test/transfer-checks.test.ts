import { describe, expect, it } from "vitest";
import { checkRecovery, checkTransfers, runChecks } from "../src/checks.ts";
import { makeWorld, type World } from "./world.ts";

/**
 * S-04 section 16.8 (migration 0028): the transfer rules come from transfer.reconcile() in the
 * database; here, their mapping to findings and severities, and that a transfer case's RecoveryGuard
 * request is no longer an unmatched S-06 request. The rules themselves run against a real database
 * in transfer/test/transfer.test.ts.
 */
const world = (): World => makeWorld({ subs: [{ outcome: "settled", tokens: 10, paisaPerToken: 1_000, wallet: 0, web: true }], rent: [] });
const request = (id: bigint) => ({ id, kind: "forced_transfer" as const, status: "pending" as const, from: "0xa1", to: "0xb1", amount: 5n });

describe("checkTransfers", () => {
  it("runs only where the transfer schema exists", () => {
    expect(checkTransfers(world().data)).toEqual([]);
  });

  it("maps each database rule to its finding and severity; an unknown rule is blocking", () => {
    const w = world();
    const row = (check: string) => ({ check, subject: "case 1", expected: "e", actual: "a" });
    w.data.transfers = {
      caseRequestIds: [],
      findings: [row("transfer.unapproved"), row("transfer.paid_not_executed"), row("transfer.paid_not_executed_overdue"), row("transfer.escrow_residual"),
        row("transfer.register_mismatch"), row("transfer.settlement_mismatch"), row("transfer.something_new")],
    };
    expect(checkTransfers(w.data).map((x) => [x.check, x.severity])).toEqual([
      ["transfer.unapproved", "blocking"],
      ["transfer.paid_not_executed", "warning"],
      ["transfer.paid_not_executed_overdue", "blocking"],
      ["transfer.escrow_residual", "blocking"],
      ["transfer.register_mismatch", "blocking"],
      ["transfer.settlement_mismatch", "blocking"],
      ["transfer.settlement_mismatch", "blocking"],
    ]);
    expect(runChecks(w.data).some((x) => x.check === "transfer.unapproved")).toBe(true);
  });

  it("a RecoveryGuard request of a transfer case is not an unmatched S-06 request; any other still is", () => {
    const w = world();
    w.data.recovery = { requests: [request(1n), request(2n)], caseRequestIds: [], reversals: [] };
    w.data.transfers = { caseRequestIds: [2n], findings: [] };
    expect(checkRecovery(w.data).map((x) => x.subject)).toEqual(["recovery request 1"]);
  });
});
