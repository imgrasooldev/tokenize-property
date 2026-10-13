import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toBytes } from "viem";
import { describe, expect, it } from "vitest";
import { COMMITMENT_DOMAIN, computeCommitment, ZERO_HASH, type CommitmentInput } from "../src/lib/anchor-commitment";

/**
 * S-07 PV-21: the browser recomputes the v1 anchor commitment (contract-spec 7.1). The code is a
 * byte-identical copy of @pt/anchor's commitment.ts (npm run sync:abis; CI compares both files), and
 * the fixed test vector is the one contracts/test/AnchorDeployment.t.sol and
 * backend/packages/anchor/test/unit.test.ts check.
 */
const VECTOR: CommitmentInput = {
  besuChainId: 586_586n,
  besuBlock: 1800n,
  besuBlockHash: keccak256(toBytes("besu-block-1800")),
  ledgerJournalId: 42n,
  ledgerHeadHash: `0x${createHash("sha256").update("ledger-head-42").digest("hex")}`,
};

describe("anchor commitment in the browser (PV-21)", () => {
  it("is the same code as @pt/anchor", () => {
    const root = join(import.meta.dirname, "..");
    const web = readFileSync(join(root, "src", "lib", "anchor-commitment.ts"));
    const backend = readFileSync(join(root, "..", "backend", "packages", "anchor", "src", "commitment.ts"));
    expect(web.equals(backend)).toBe(true);
  });

  it("matches the shared test vector", () => {
    expect(COMMITMENT_DOMAIN).toBe(keccak256(toBytes("property-token/state-anchor/v1")));
    expect(computeCommitment(VECTOR)).toBe("0xd37e43dfa7699fa914302afe3161b28b7802f869ee6bad9fc27f5532706e6906");
  });

  it("changes when any component is tampered with", () => {
    const honest = computeCommitment(VECTOR);
    const tampered = [
      { ...VECTOR, besuChainId: 586_587n },
      { ...VECTOR, besuBlock: 1801n },
      { ...VECTOR, besuBlockHash: keccak256(toBytes("besu-block-1800-rewritten")) },
      { ...VECTOR, ledgerJournalId: 43n },
      { ...VECTOR, ledgerHeadHash: keccak256(toBytes("edited ledger")) },
    ];
    for (const t of tampered) expect(computeCommitment(t)).not.toBe(honest);
  });

  it("refuses malformed components instead of computing a value", () => {
    expect(() => computeCommitment({ ...VECTOR, besuBlockHash: ZERO_HASH })).toThrow();
    expect(() => computeCommitment({ ...VECTOR, besuBlock: 0n })).toThrow();
    expect(() => computeCommitment({ ...VECTOR, ledgerJournalId: 0n })).toThrow();
  });
});
