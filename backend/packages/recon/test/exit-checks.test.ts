import { buildFinalDocuments, redemptionRefId } from "@pt/exit";
import { keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { checkExit, checkIssuance, runChecks } from "../src/checks.ts";
import type { ExitData, ExitLine } from "../src/types.ts";
import { AS_OF, makeWorld, TOKEN, wallet } from "./world.ts";

/**
 * S-05 reconciliation (spec S-05 section 7 and 14.3, migration 0027): burns are lines of an approved
 * redemption batch with exactly their units; refIds are the documented derivation; after_payment
 * burns follow payment; supply reaches 0 within the SLA; the exit pool and the trustee register are
 * empty when they must be; final statements are consistent.
 */
const line = (i: number, o: Partial<ExitLine> = {}): ExitLine => ({
  caseId: 1n, caseState: "redeeming", redemptionStatus: "approved", burnRule: "after_payment", distributionId: 7n,
  wallet: wallet(i), units: BigInt(10 * (i + 1)), refId: redemptionRefId(TOKEN, 7n, wallet(i)), payment: "paid", released: false, ...o,
});

function exitData(lines: ExitLine[], o: Partial<ExitData> = {}): ExitData {
  return { lines, cases: [{ caseId: 1n, state: "redeeming", redeemingAt: AS_OF, finalBooked: true, poolBalance: 0n, closureReserve: 0n, registerUnits: 0n }], finals: [],
    redeemingSlaMs: 72 * 3_600_000, ...o };
}

const burn = (l: ExitLine, amount = l.units, account = l.wallet) => ({ refId: l.refId, kind: "burn" as const, account, amount, blockNumber: 20n, blockTime: AS_OF, txHash: keccak256(toHex(l.refId)) });
const names = (xs: { check: string }[]): string[] => xs.map((x) => x.check).sort();

describe("checkExit and the burn checks", () => {
  it("is quiet for a consistent redemption", () => {
    const w = makeWorld({ subs: [], rent: [] });
    const ls = [line(0), line(1, { payment: "nothing_to_pay" }), line(2, { payment: "held", released: true })];
    w.data.exit = exitData(ls);
    w.data.chain.issuances.push(...ls.map((l) => burn(l)));
    expect(checkExit(w.data)).toEqual([]);
    expect(names(checkIssuance(w.data))).toEqual([]);
  });

  it("blocks an orphan burn, a burn of a batch not approved and a burn of other units or another wallet", () => {
    const w = makeWorld({ subs: [], rent: [] });
    const ok = line(0);
    const notApproved = line(1, { redemptionStatus: "checked" });
    const wrong = line(2);
    w.data.exit = exitData([ok, notApproved, wrong]);
    w.data.chain.issuances.push(burn(ok), burn(notApproved), burn(wrong, wrong.units - 1n), { ...burn(ok), refId: keccak256(toHex("stranger")) });
    const found = checkIssuance(w.data).filter((x) => x.check.startsWith("issuance."));
    expect(names(found)).toEqual(["issuance.burn_amount_mismatch", "issuance.orphan_burn", "issuance.orphan_burn"]);
    expect(found.every((x) => x.severity === "blocking")).toBe(true);
    const w2 = makeWorld({ subs: [], rent: [] });
    w2.data.exit = exitData([ok]);
    w2.data.chain.issuances.push(burn(ok, ok.units, wallet(9)));
    expect(names(checkIssuance(w2.data))).toEqual(["issuance.burn_amount_mismatch"]);
  });

  it("blocks a refId that is not the derivation and a burn before payment", () => {
    const w = makeWorld({ subs: [], rent: [] });
    const bad = line(0, { refId: keccak256(toHex("other")) });
    const early = line(1, { payment: "held" });
    const inPayment = line(2, { payment: "in_payment" });
    const finalization = line(3, { payment: "unpaid", burnRule: "after_finalization" });
    w.data.exit = exitData([bad, early, inPayment, finalization]);
    w.data.chain.issuances.push(burn(early), burn(inPayment), burn(finalization));
    expect(names(checkExit(w.data))).toEqual(["exit.burn_before_payment", "exit.burn_before_payment", "exit.ref_id_mismatch"]);
  });

  it("supply not zero: a warning while Redeeming, blocking after the SLA and after Paid Out", () => {
    const w = makeWorld({ subs: [], rent: [] });
    w.data.chain.onChain.totalSupply = 5n;
    w.data.exit = exitData([]);
    expect(checkExit(w.data).map((x) => [x.check, x.severity])).toEqual([["exit.supply_not_zero", "warning"]]);
    w.data.exit = exitData([], { cases: [{ caseId: 1n, state: "redeeming", redeemingAt: new Date(AS_OF.getTime() - 73 * 3_600_000), finalBooked: true, poolBalance: 0n, closureReserve: 0n, registerUnits: 0n }] });
    expect(checkExit(w.data).map((x) => x.severity)).toEqual(["blocking"]);
    w.data.exit = exitData([], { cases: [{ caseId: 1n, state: "paid_out", redeemingAt: AS_OF, finalBooked: true, poolBalance: 0n, closureReserve: 0n, registerUnits: 0n }] });
    expect(checkExit(w.data).map((x) => [x.check, x.severity])).toEqual([["exit.supply_not_zero", "blocking"]]);
  });

  it("pool, closure reserve and register must be empty when the state says so", () => {
    const w = makeWorld({ subs: [], rent: [] });
    w.data.chain.onChain.totalSupply = 0n;
    w.data.exit = exitData([], { cases: [{ caseId: 1n, state: "closed", redeemingAt: AS_OF, finalBooked: true, poolBalance: 3n, closureReserve: 2n, registerUnits: 1n }] });
    expect(names(checkExit(w.data))).toEqual(["exit.register_mismatch", "exit.waterfall_mismatch", "exit.waterfall_mismatch"]);
  });

  it("re-verifies final statements and compares the booked one with the chain", () => {
    const w = makeWorld({ subs: [], rent: [] });
    const d = buildFinalDocuments({ id: "4", caseId: "1", token: TOKEN, recordDate: "2026-10-12", recordBlock: "10", incomeType: "exit_distribution", proceeds: 100n,
      inflows: 0n, outflows: 0n, distributableGross: 100n, wht: 0n, net: 100n, units: "10" },
      [{ wallet: wallet(0), subject: null, units: "10", gross: 100n, status: "exempt", filerCheck: null, filerAsOf: null, flagged: false, rateId: "1", ratePpm: 0, wht: 0n, net: 100n }]);
    const doc = { id: "4", status: "booked", onchainId: 7n, statement: d.statement, statementHash: d.statementHash, schedule: d.schedule, scheduleHash: d.scheduleHash, root: d.root };
    w.data.exit = exitData([], { finals: [doc] });
    w.data.chain.onChain.totalSupply = 0n;
    expect(checkExit(w.data)).toEqual([]);
    w.data.chain.distributions.push({ id: 7n, token: TOKEN, totalPaisa: 100n, statementHash: keccak256(toHex("other")), status: "finalized", payoutBatchHash: null });
    w.data.exit = exitData([], { finals: [{ ...doc, statement: `${d.statement} ` }] });
    const found = names(checkExit(w.data));
    expect(found).toContain("exit.statement_totals");
    expect(found.length).toBeGreaterThanOrEqual(2);
  });

  it("is part of runChecks and does nothing without exit data", () => {
    const w = makeWorld({ subs: [], rent: [] });
    expect(checkExit(w.data)).toEqual([]);
    w.data.exit = exitData([line(0, { refId: keccak256(toHex("x")) })]);
    expect(runChecks(w.data).map((x) => x.check)).toContain("exit.ref_id_mismatch");
  });
});
