import { describe, expect, it } from "vitest";
import { checkCash, checkRecovery, runChecks, voidedJournals } from "../src/checks.ts";
import type { LedgerJournal, ReconData } from "../src/types.ts";
import { BANK_LEDGER, makeWorld, type World } from "./world.ts";

/**
 * S-06 section 14.7 (migration 0020): RecoveryGuard requests must belong to a recovery case, and a
 * correcting journal of a closed reversal case voids the journal it reverses for cash matching.
 */
const world = (): World =>
  makeWorld({ subs: [{ outcome: "settled", tokens: 10, paisaPerToken: 1_000, wallet: 0, web: true }], rent: [{ status: "finalized", total: 300 }] });

function bankJournal(d: ReconData): LedgerJournal {
  const j = d.ledger.journals.find((x) => x.externalRef && x.postings.some((p) => p.account === BANK_LEDGER));
  if (!j) throw new Error("no bank journal in the world");
  return j;
}

const request = (id: bigint, status: "pending" | "executed" | "cancelled") => ({ id, kind: "forced_transfer" as const, status, from: "0xa1", to: "0xb1", amount: 5n });

describe("checkRecovery", () => {
  it("runs only where the recovery schema exists", () => {
    const w = world();
    expect(checkRecovery(w.data)).toEqual([]);
    expect(voidedJournals(w.data).size).toBe(0);
  });

  it("a pending or executed request without a case is blocking; a cancelled one is a warning; a case's request is quiet", () => {
    const w = world();
    w.data.recovery = { requests: [request(1n, "cancelled"), request(2n, "executed"), request(3n, "pending"), request(4n, "executed")], caseRequestIds: [4n], reversals: [] };
    const f = checkRecovery(w.data);
    expect(f.map((x) => [x.check, x.severity, x.subject])).toEqual([
      ["recovery.unmatched_cancelled", "warning", "recovery request 1"],
      ["recovery.unmatched", "blocking", "recovery request 2"],
      ["recovery.unmatched", "blocking", "recovery request 3"],
    ]);
  });

  it("a reversal journal needs its closed case, and a case its reversal journal", () => {
    const w = world();
    const j = bankJournal(w.data);
    const reversal: LedgerJournal = { ...j, id: 900n, key: "case:ab:reversal", kind: "reversal", postings: j.postings.map((p) => ({ ...p, amount: -p.amount })) };
    w.data.ledger.journals.push(reversal);
    w.data.recovery = { requests: [], caseRequestIds: [], reversals: [] };
    expect(checkRecovery(w.data).map((x) => x.check)).toEqual(["recovery.reversal_unmatched"]);
    w.data.recovery.reversals.push({ caseId: 1n, journalId: j.id, reversalJournalId: 900n });
    expect(checkRecovery(w.data)).toEqual([]);
    w.data.recovery.reversals.push({ caseId: 2n, journalId: j.id, reversalJournalId: 901n });
    expect(checkRecovery(w.data).map((x) => [x.check, x.subject])).toEqual([["recovery.reversal_unmatched", "reversal case 2"]]);
  });
});

describe("cash matching with reversals (RF-20)", () => {
  it("a duplicate booking breaks cash; its reversal (with the closed case) makes cash reconcile again", () => {
    const w = world();
    expect(checkCash(w.data)).toEqual([]);
    const j = bankJournal(w.data);
    const dup: LedgerJournal = { ...j, id: 800n, key: `${j.key}:again`, createdAt: new Date(j.createdAt.getTime() + 1_000) };
    w.data.ledger.journals.push(dup);
    const broken = checkCash(w.data).map((x) => x.check);
    expect(broken).toEqual(expect.arrayContaining(["cash.duplicate_ledger_entry"]));

    const fix: LedgerJournal = { ...dup, id: 801n, key: "case:cd:reversal", kind: "reversal", createdAt: new Date(dup.createdAt.getTime() + 1_000), postings: dup.postings.map((p) => ({ ...p, amount: -p.amount })) };
    w.data.ledger.journals.push(fix);
    // Without its case the correcting journal is not trusted: cash stays broken and the journal is reported.
    w.data.recovery = { requests: [], caseRequestIds: [], reversals: [] };
    expect(checkCash(w.data).length).toBeGreaterThan(0);
    expect(runChecks(w.data).map((x) => x.check)).toContain("recovery.reversal_unmatched");
    // With the closed case both journals are void: cash and recovery are clean.
    w.data.recovery.reversals.push({ caseId: 7n, journalId: 800n, reversalJournalId: 801n });
    expect(voidedJournals(w.data)).toEqual(new Set([800n, 801n]));
    expect(checkCash(w.data)).toEqual([]);
    expect(checkRecovery(w.data)).toEqual([]);
  });
});
