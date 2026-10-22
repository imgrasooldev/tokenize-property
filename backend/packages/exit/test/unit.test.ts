import { verifyDocuments, type ScheduleLine } from "@pt/tax";
import { keccak256, stringToBytes } from "viem";
import { describe, expect, it } from "vitest";
import { buildFinalDocuments, redemptionRefId, type FinalHeader } from "../src/index.ts";

/** Pure parts of @pt/exit: the refId derivation and the final distribution's documents. */
const W1 = `0x${"1".repeat(40)}`;
const W2 = `0x${"2".repeat(40)}`;
const W3 = `0x${"3".repeat(40)}`;
const TOKEN = `0x${"a".repeat(40)}`;

const line = (wallet: string, units: string, gross: bigint, wht: bigint): ScheduleLine => ({
  wallet, subject: null, units, gross, status: "non_filer", filerCheck: null, filerAsOf: null, flagged: true, rateId: "1", ratePpm: 300000, wht, net: gross - wht,
});

describe("redemptionRefId", () => {
  it("is keccak256 of the documented text with lower-case addresses", () => {
    expect(redemptionRefId(TOKEN.toUpperCase().replace("0X", "0x"), 7n, W1)).toBe(keccak256(stringToBytes(`property-token:redemption:${TOKEN}:7:${W1}`)));
    expect(redemptionRefId(TOKEN, "7", W1)).not.toBe(redemptionRefId(TOKEN, "7", W2));
    expect(() => redemptionRefId(TOKEN, 0n, W1)).toThrow();
    expect(() => redemptionRefId("nope", 1n, W1)).toThrow();
  });
});

describe("buildFinalDocuments", () => {
  const h: FinalHeader = {
    id: "3", caseId: "1", token: TOKEN, recordDate: "2026-10-22", recordBlock: "10", incomeType: "exit_distribution",
    proceeds: 1000n, inflows: 0n, outflows: 100n, distributableGross: 900n, wht: 270n, net: 630n, units: "1000",
  };
  const lines = [line(W2, "300", 270n, 81n), line(W1, "699", 629n, 189n), line(W3, "1", 1n, 0n)];

  it("is consistent for @pt/tax verifyDocuments (hashes, root, totals, per-line rounding)", () => {
    const d = buildFinalDocuments(h, lines);
    expect(verifyDocuments({ statement: d.statement, statementHash: d.statementHash, schedule: d.schedule, scheduleHash: d.scheduleHash, root: d.root })).toEqual([]);
    const s = JSON.parse(d.statement) as Record<string, unknown>;
    expect(s).toMatchObject({ kind: "pt-rent-statement-v2", distributionKind: "final", exitCase: "1", period: "final" });
    expect((s.entitlements as { wallet: string }[]).map((e) => e.wallet)).toEqual([W1, W2, W3]);
  });

  it("is deterministic and changes with any amount", () => {
    expect(buildFinalDocuments(h, [...lines].reverse()).statementHash).toBe(buildFinalDocuments(h, lines).statementHash);
    const other = buildFinalDocuments(h, [line(W2, "300", 270n, 80n), line(W1, "699", 629n, 189n), line(W3, "1", 1n, 0n)]);
    expect(other.root).not.toBe(buildFinalDocuments(h, lines).root);
  });

  it("leaves a zero line out of the leaves but keeps it in the schedule", () => {
    const d = buildFinalDocuments({ ...h, wht: 270n, net: 629n, distributableGross: 899n }, [line(W2, "300", 270n, 81n), line(W1, "699", 629n, 189n), line(W3, "1", 0n, 0n)]);
    expect(d.entitlements.map((e) => e.wallet)).toEqual([W1, W2]);
    expect((JSON.parse(d.schedule) as { lines: unknown[] }).lines).toHaveLength(3);
  });
});
