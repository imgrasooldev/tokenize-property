import { buildDocuments, splitDistribution, type ScheduleLine } from "@pt/tax";
import { describe, expect, it } from "vitest";
import { checkTax, runChecks } from "../src/checks.ts";
import type { ReconData } from "../src/types.ts";
import { makeWorld, TOKEN, wallet } from "./world.ts";

/**
 * S-03 §8 tax checks in reconciliation (migration 0021): the database's tax.reconcile() rows
 * become findings with their stable names and severities, and every attached statement is
 * re-verified independently (hashes, Merkle root of the NET entitlements, totals, rounding).
 */
function documents(onchainId: bigint | null, status: string): NonNullable<ReconData["tax"]>["documents"][number] {
  const lines = splitDistribution(1_000_003n, [
    { wallet: wallet(0), units: 70n, ratePpm: 150_000 },
    { wallet: wallet(1), units: 30n, ratePpm: 300_000 },
  ]);
  const schedule: ScheduleLine[] = lines.map((l, i) => ({ wallet: l.wallet, subject: null, units: l.units.toString(), gross: l.gross, status: i === 0 ? "filer" : "non_filer",
    filerCheck: null, filerAsOf: null, flagged: true, rateId: String(i + 1), ratePpm: i === 0 ? 150_000 : 300_000, wht: l.wht, net: l.net }));
  const d = buildDocuments({ id: "1", token: TOKEN, period: "2026-09", recordDate: "2026-10-05", recordBlock: "9", incomeType: "reit_dividend", collected: 1_000_003n,
    expenses: 0n, fees: 0n, reserveContribution: 0n, reserveRelease: 0n, distributableGross: 1_000_003n,
    wht: lines.reduce((a, l) => a + l.wht, 0n), net: lines.reduce((a, l) => a + l.net, 0n) }, schedule);
  return { id: "1", status, onchainId, statement: d.statement, statementHash: d.statementHash, schedule: d.schedule, scheduleHash: d.scheduleHash, root: d.root };
}

describe("checkTax", () => {
  it("is quiet for consistent data, and absent data runs no tax check", () => {
    const w = makeWorld({ subs: [], rent: [] });
    expect(checkTax(w.data)).toEqual([]);
    w.data.tax = { findings: [], documents: [documents(null, "approved")] };
    expect(checkTax(w.data)).toEqual([]);
  });

  it("turns the database's rule violations into findings with their severities", () => {
    const w = makeWorld({ subs: [], rent: [] });
    w.data.tax = {
      findings: [
        { check: "tax.payable_mismatch", subject: `tax:wht-payable:${TOKEN} 2026-09`, expected: "withheld 5 - remitted 0 = 5", actual: "ledger 6" },
        { check: "tax.wht_unremitted", subject: `tax:wht-payable:${TOKEN} 2026-08`, expected: "remitted within 15 days", actual: "5 outstanding" },
        { check: "rent.wht_mismatch", subject: "distribution 3", expected: "5", actual: "4" },
      ],
      documents: [],
    };
    const found = checkTax(w.data);
    expect(found.map((x) => [x.check, x.severity])).toEqual([
      ["tax.payable_mismatch", "blocking"],
      ["tax.wht_unremitted", "warning"],
      ["rent.wht_mismatch", "blocking"],
    ]);
    expect(runChecks(w.data).map((x) => x.check)).toEqual(expect.arrayContaining(["tax.payable_mismatch", "rent.wht_mismatch"]));
  });

  it("finds a statement edited after hashing, a root of other amounts, and a booked statement the chain does not hold", () => {
    const w = makeWorld({ subs: [], rent: [] });
    const good = documents(7n, "booked");
    w.data.chain.distributions.push({ id: 7n, token: TOKEN, totalPaisa: 1n, statementHash: `0x${"ab".repeat(32)}`, status: "finalized", payoutBatchHash: null });
    w.data.tax = {
      findings: [],
      documents: [good, { ...good, id: "2", status: "approved", onchainId: null, statement: good.statement.replace('"incomeType"', ' "incomeType"') }, { ...good, id: "3", status: "approved", onchainId: null, root: `0x${"cd".repeat(32)}` }],
    };
    const found = checkTax(w.data);
    expect(found.every((x) => x.check === "rent.statement_totals" && x.severity === "blocking")).toBe(true);
    expect(found.map((x) => x.subject).sort()).toEqual(["calculation 1", "calculation 2", "calculation 3"]);
    expect(found.find((x) => x.subject === "calculation 1")?.actual).toMatch(/on chain/);
  });
});
