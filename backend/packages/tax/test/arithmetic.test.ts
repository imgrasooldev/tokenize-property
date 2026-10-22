import fc from "fast-check";
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { largestRemainder, percent, rupees, splitDistribution, withholding } from "../src/arithmetic.ts";
import { buildTree, processProof, rentLeaf } from "../src/merkle.ts";
import { buildDocuments, canonicalJson, keccakText, verifyDocuments, type CalculationHeader, type ScheduleLine } from "../src/statement.ts";
import { formatCnic, maskCnic } from "../src/crypto.ts";

/**
 * S-03 arithmetic without a database (OP-35, OP-36, OP-37): integer paisa only, the rounding rule
 * at the half paisa, sum invariants under random holders and rates, and the Merkle leaf of /verify.
 */
const wallet = (i: number): string => `0x${i.toString(16).padStart(40, "0")}`;

describe("withholding: round half up to the paisa (OT-4)", () => {
  it("matches the S-03 worked example", () => {
    expect(withholding(17_523_000n, 150_000)).toBe(2_628_450n); // A: 175,230.00 x 15 %
    expect(withholding(438_075n, 300_000)).toBe(131_423n); // B: 1,314.225 rounded half up to 1,314.23
    expect(withholding(1_227n, 150_000)).toBe(184n); // C: 12.27 x 15 % = 1.8405 -> 1.84
  });

  it("rounds exactly at the half paisa, never with floating point", () => {
    expect(withholding(1n, 500_000)).toBe(1n); // 0.5 -> 1
    expect(withholding(1n, 499_999)).toBe(0n); // 0.499999 -> 0
    expect(withholding(3n, 500_000)).toBe(2n); // 1.5 -> 2
    expect(withholding(0n, 999_999)).toBe(0n);
    // 2^60 paisa at 15 %: far beyond Number.MAX_SAFE_INTEGER, still exact.
    const big = 2n ** 60n;
    expect(withholding(big, 150_000)).toBe((big * 150_000n + 500_000n) / 1_000_000n);
  });

  it("refuses negative gross and rates of 100 % or more", () => {
    expect(() => withholding(-1n, 1)).toThrow();
    expect(() => withholding(1n, 1_000_000)).toThrow();
    expect(() => withholding(1n, -1)).toThrow();
  });

  it("property: 0 <= WHT <= gross and |WHT - exact| <= half a paisa", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 15n }), fc.integer({ min: 0, max: 999_999 }), (g, r) => {
        const w = withholding(g, r);
        const exact2 = g * BigInt(r) * 2n; // twice the exact amount in micro-paisa
        expect(w >= 0n && w <= g).toBe(true);
        const diff = w * 2_000_000n - exact2;
        expect(diff <= 1_000_000n && diff > -1_000_000n).toBe(true);
      }),
    );
  });
});

describe("largest remainder (OP-35)", () => {
  it("sums exactly, ties go to the lower wallet", () => {
    const s = largestRemainder(100n, new Map([[wallet(2), 1n], [wallet(1), 1n], [wallet(3), 1n]]));
    expect([...s.values()].reduce((a, b) => a + b, 0n)).toBe(100n);
    expect(s.get(wallet(1))).toBe(34n);
    expect(s.get(wallet(2))).toBe(33n);
    expect(s.get(wallet(3))).toBe(33n);
  });

  it("single holder takes everything; equal holders split evenly", () => {
    expect(largestRemainder(175_230_000n, new Map([[wallet(9), 7n]])).get(wallet(9))).toBe(175_230_000n);
    const even = largestRemainder(400n, new Map([1, 2, 3, 4].map((i) => [wallet(i), 25n])));
    expect([...even.values()]).toEqual([100n, 100n, 100n, 100n]);
  });

  it("the worked example: 1,000,000 units, Rs 1,752,300.00", () => {
    const s = largestRemainder(175_230_000n, new Map([[wallet(1), 100_000n], [wallet(2), 2_500n], [wallet(3), 7n], [wallet(4), 897_493n]]));
    expect(s.get(wallet(1))).toBe(17_523_000n);
    expect(s.get(wallet(2))).toBe(438_075n);
    expect([1_226n, 1_227n]).toContain(s.get(wallet(3))); // exact 12.2661 -> 12.26 or 12.27
  });

  it("property: random holders and rates: sum(gross) = total, gross = net + WHT per line, sum(net) + sum(WHT) = total", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 13n }),
        fc.array(fc.record({ units: fc.bigInt({ min: 1n, max: 10n ** 20n }), rate: fc.constantFrom(0, 150_000, 300_000, 125_000, 999_999) }), { minLength: 1, maxLength: 40 }),
        (total, hs) => {
          const holders = hs.map((h, i) => ({ wallet: wallet(i + 1), units: h.units, ratePpm: h.rate }));
          const lines = splitDistribution(total, holders);
          let g = 0n;
          let n = 0n;
          let w = 0n;
          for (const l of lines) {
            expect(l.gross).toBe(l.net + l.wht);
            expect(l.gross > 0n).toBe(true);
            g += l.gross;
            n += l.net;
            w += l.wht;
          }
          expect(g).toBe(total);
          expect(n + w).toBe(total);
        },
      ),
    );
  });
});

describe("formatting without floating point", () => {
  it("rupees and percent", () => {
    expect(rupees(175_230_000n)).toBe("1752300.00");
    expect(rupees(5n)).toBe("0.05");
    expect(rupees(-131_423n)).toBe("-1314.23");
    expect(percent(150_000)).toBe("15.0000");
    expect(percent(125_000)).toBe("12.5000");
    expect(percent(7)).toBe("0.0007");
  });

  it("CNIC: filing format and the mask that is the only thing ever shown", () => {
    expect(formatCnic("3520212345671")).toBe("35202-1234567-1");
    expect(maskCnic("3520212345671")).toBe("*****-****567-1");
    expect(() => formatCnic("123")).toThrow();
  });
});

describe("Merkle leaf = (wallet, NET paisa), the leaf of /verify (OP-37)", () => {
  // The same construction as web/src/lib/merkle.ts rentLeaf, written out independently.
  const webLeaf = (w: Address, a: bigint): Hex => keccak256(keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [w, a])));

  it("leaf format unchanged; every proof verifies; one paisa more fails", () => {
    const amounts = [14_894_550n, 306_652n, 1_043n, 99n, 1n];
    const leaves = amounts.map((a, i) => rentLeaf(wallet(i + 1) as Address, a));
    leaves.forEach((l, i) => {
      expect(l).toBe(webLeaf(wallet(i + 1) as Address, amounts.at(i) ?? 0n));
    });
    const { root, proofs } = buildTree(leaves);
    leaves.forEach((l, i) => {
      expect(processProof(l, proofs.at(i) ?? [])).toBe(root);
    });
    expect(processProof(rentLeaf(wallet(1) as Address, 14_894_551n), proofs[0] ?? [])).not.toBe(root);
    expect(buildTree([leaves[0] as Hex]).root).toBe(leaves[0]);
  });
});

describe("statement v2 and tax schedule v1 (OP-38)", () => {
  const header: CalculationHeader = {
    id: "7", token: wallet(77), period: "2026-08", recordDate: "2026-09-05", recordBlock: "10", incomeType: "reit_dividend",
    collected: 230_000_000n, expenses: 17_500_000n, fees: 17_800_000n, reserveContribution: 19_470_000n, reserveRelease: 0n,
    distributableGross: 175_230_000n, wht: 0n, net: 0n,
  };
  function lines(): ScheduleLine[] {
    const ls = splitDistribution(175_230_000n, [
      { wallet: wallet(1), units: 100_000n, ratePpm: 150_000 },
      { wallet: wallet(2), units: 2_500n, ratePpm: 300_000 },
      { wallet: wallet(3), units: 897_500n, ratePpm: 300_000 },
    ]);
    return ls.map((l, i) => ({ wallet: l.wallet, subject: i === 2 ? null : `00000000-0000-0000-0000-00000000000${String(i)}`, units: l.units.toString(), gross: l.gross, status: i === 0 ? "filer" : "non_filer",
      filerCheck: i === 0 ? "1" : null, filerAsOf: i === 0 ? "2026-09-01" : null, flagged: i !== 0, rateId: i === 0 ? "1" : "2", ratePpm: i === 0 ? 150_000 : 300_000, wht: l.wht, net: l.net }));
  }

  it("canonical JSON sorts keys and keeps integers as strings", () => {
    expect(canonicalJson({ b: "1", a: [{ d: null, c: true }] })).toBe('{"a":[{"c":true,"d":null}],"b":"1"}');
  });

  it("is consistent, binds the schedule's hash, and a tampered line or total is found", () => {
    const ls = lines();
    const h = { ...header, wht: ls.reduce((a, l) => a + l.wht, 0n), net: ls.reduce((a, l) => a + l.net, 0n) };
    const d = buildDocuments(h, ls);
    const stored = { statement: d.statement, statementHash: d.statementHash, schedule: d.schedule, scheduleHash: d.scheduleHash, root: d.root };
    expect(verifyDocuments(stored)).toEqual([]);
    expect((JSON.parse(d.statement) as { taxScheduleHash: string }).taxScheduleHash).toBe(d.scheduleHash);
    expect(d.statement).not.toMatch(/subject|non_filer|filer/); // the public statement carries no tax status
    // Mutation: one paisa moved from WHT to net in the schedule (rehashed, so only the content check can find it).
    const sched = JSON.parse(d.schedule) as { lines: { whtPaisa: string; netPaisa: string }[] };
    const first = sched.lines[0];
    if (!first) throw new Error("no line");
    first.whtPaisa = (BigInt(first.whtPaisa) - 1n).toString();
    first.netPaisa = (BigInt(first.netPaisa) + 1n).toString();
    const forged = canonicalJson(sched);
    const problems = verifyDocuments({ ...stored, schedule: forged, scheduleHash: keccakText(forged) });
    expect(problems.join("; ")).toMatch(/rounding rule|another tax schedule|entitlement differs/);
    // Mutation: the root of a different amount.
    expect(verifyDocuments({ ...stored, root: buildTree([rentLeaf(wallet(1) as Address, 1n)]).root }).join()).toMatch(/Merkle root/);
    // Mutation: the statement edited after hashing.
    expect(verifyDocuments({ ...stored, statement: d.statement.replace('"collected":"', '"collected":"1') }).join()).toMatch(/does not hash/);
  });
});
