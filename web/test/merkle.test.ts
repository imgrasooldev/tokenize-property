import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { entitlementText, hashPair, parseEntitlement, processProof, rentLeaf, verifyEntitlementProof } from "../src/lib/merkle";

/**
 * S-07 PV-31/PV-32: the browser's leaf, root and statement-hash computation against real output of
 * chain/rent.py (two published distributions from the local network, copied as fixtures: a
 * two-leaf tree and a deeper one with an odd number of leaves).
 */
interface Statement {
  id: number;
  root: Hex;
  statementHash: Hex;
  statement: string;
  entitlements: { wallet: Address; amountPaisa: number; tokens: number; proof: Hex[] }[];
}

const load = (name: string): Statement =>
  // Fixed fixture path inside the repository.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")) as Statement;

const FIXTURES = [load("rent-statement-2.json"), load("rent-statement-3.json")];

describe("rent Merkle proofs (chain/rent.py fixtures)", () => {
  for (const s of FIXTURES) {
    it(`distribution ${String(s.id)}: every entitlement leads to the published root; 1 paisa more does not`, () => {
      expect(s.entitlements.length).toBeGreaterThan(1);
      for (const e of s.entitlements) {
        const amount = BigInt(e.amountPaisa);
        expect(verifyEntitlementProof(s.root, e.wallet, amount, e.proof)).toBe(true);
        expect(verifyEntitlementProof(s.root, e.wallet, amount + 1n, e.proof)).toBe(false);
        expect(verifyEntitlementProof(s.root, e.wallet, amount - 1n, e.proof)).toBe(false);
      }
    });

    it(`distribution ${String(s.id)}: the statement hashes to the statement hash (PV-32)`, () => {
      expect(keccak256(stringToBytes(s.statement))).toBe(s.statementHash);
      expect(keccak256(stringToBytes(`${s.statement} `))).not.toBe(s.statementHash);
    });
  }

  it("refuses another wallet, a swapped proof element and a different root", () => {
    const s = FIXTURES[1];
    if (!s) throw new Error("fixture missing");
    const [a, b] = s.entitlements;
    if (!a || !b) throw new Error("fixture too small");
    expect(verifyEntitlementProof(s.root, b.wallet, BigInt(a.amountPaisa), a.proof)).toBe(false);
    if (a.proof.length > 1) expect(verifyEntitlementProof(s.root, a.wallet, BigInt(a.amountPaisa), [...a.proof].reverse())).toBe(false);
    expect(verifyEntitlementProof(FIXTURES[0]?.root ?? "0x", a.wallet, BigInt(a.amountPaisa), a.proof)).toBe(false);
    // Upper-case input is the same value.
    expect(verifyEntitlementProof(s.root.toUpperCase().replace("0X", "0x") as Hex, a.wallet, BigInt(a.amountPaisa), a.proof)).toBe(true);
  });

  it("uses sorted pairs and the double-hashed leaf of OpenZeppelin's MerkleProof", () => {
    const s = FIXTURES[0];
    const [a, b] = s?.entitlements ?? [];
    if (!s || !a || !b) throw new Error("fixture missing");
    const la = rentLeaf(a.wallet, BigInt(a.amountPaisa));
    const lb = rentLeaf(b.wallet, BigInt(b.amountPaisa));
    expect(hashPair(la, lb)).toBe(hashPair(lb, la));
    expect(hashPair(la, lb)).toBe(s.root);
    expect(a.proof).toEqual([lb]);
    expect(processProof(la, [])).toBe(la);
    expect(() => rentLeaf(a.wallet, -1n)).toThrow();
  });
});

describe("entitlement input", () => {
  const sample = { distributionId: 3n, wallet: "0x3ab55575f2dd6c52976b50f64b0a39e97feb6eb5" as Address, amountPaisa: 1660313n, proof: [`0x${"ab".repeat(32)}`] };

  it("round-trips the text the portfolio offers", () => {
    expect(parseEntitlement(entitlementText(sample))).toEqual(sample);
  });

  it("accepts numbers and mixed-case hex, normalised to lower case", () => {
    const e = parseEntitlement(JSON.stringify({ distributionId: 3, wallet: "0x3AB55575F2DD6C52976B50F64B0A39E97FEB6EB5", amountPaisa: 1660313, proof: [`0x${"AB".repeat(32)}`] }));
    expect(e).toEqual(sample);
  });

  it("refuses anything that is not exactly an entitlement", () => {
    const base = { distributionId: "3", wallet: sample.wallet, amountPaisa: "1660313", proof: sample.proof };
    for (const bad of [
      "not json",
      JSON.stringify({ ...base, amountPaisa: "16603.13" }),
      JSON.stringify({ ...base, amountPaisa: 1.5 }),
      JSON.stringify({ ...base, amountPaisa: "-1" }),
      JSON.stringify({ ...base, distributionId: "0" }),
      JSON.stringify({ ...base, wallet: "0x123" }),
      JSON.stringify({ ...base, proof: ["0x12"] }),
      JSON.stringify({ ...base, proof: Array.from({ length: 65 }, () => sample.proof[0]) }),
      JSON.stringify({ ...base, extra: 1 }),
      JSON.stringify({ ...base, wallet: undefined }),
      "x".repeat(20_001),
    ]) {
      expect(parseEntitlement(bad), bad.slice(0, 80)).toBeNull();
    }
  });
});
