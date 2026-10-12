import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, toBytes, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { COMMITMENT_DOMAIN, computeCommitment, ZERO_HASH } from "../src/commitment.ts";
import { anchorDeploymentFromBroadcast } from "../src/deployment.ts";
import { LOCAL_ANCHOR_CHAIN_ID, readProblem, sendProblem } from "../src/network.ts";

describe("anchor commitment (contract-spec 7.1)", () => {
  it("matches the Solidity test vector in contracts/test/AnchorDeployment.t.sol", () => {
    const c = computeCommitment({
      besuChainId: 586_586n,
      besuBlock: 1800n,
      besuBlockHash: keccak256(toBytes("besu-block-1800")),
      ledgerJournalId: 42n,
      ledgerHeadHash: `0x${createHash("sha256").update("ledger-head-42").digest("hex")}`,
    });
    expect(COMMITMENT_DOMAIN).toBe(keccak256(toBytes("property-token/state-anchor/v1")));
    expect(c).toBe("0xd37e43dfa7699fa914302afe3161b28b7802f869ee6bad9fc27f5532706e6906");
  });

  it("changes with every component and refuses malformed input", () => {
    const base = { besuChainId: 586_586n, besuBlock: 10n, besuBlockHash: keccak256(toBytes("b")), ledgerJournalId: 3n, ledgerHeadHash: keccak256(toBytes("l")) };
    const c = computeCommitment(base);
    const variants = [
      { ...base, besuChainId: 586_587n },
      { ...base, besuBlock: 11n },
      { ...base, besuBlockHash: keccak256(toBytes("b2")) },
      { ...base, ledgerJournalId: 4n },
      { ...base, ledgerHeadHash: keccak256(toBytes("l2")) },
    ];
    for (const v of variants) expect(computeCommitment(v)).not.toBe(c);
    expect(computeCommitment({ ...base, besuBlockHash: base.besuBlockHash.toUpperCase().replace("0X", "0x") as Hex })).toBe(c);
    expect(() => computeCommitment({ ...base, besuBlockHash: ZERO_HASH })).toThrow(/block hash/);
    expect(() => computeCommitment({ ...base, besuBlock: 0n })).toThrow(/range/);
    expect(() => computeCommitment({ ...base, besuBlock: 2n ** 64n })).toThrow(/range/);
    expect(() => computeCommitment({ ...base, ledgerJournalId: 0n })).toThrow(/id 0/);
    expect(() => computeCommitment({ ...base, ledgerHeadHash: ZERO_HASH })).toThrow(/id 0/);
    expect(() => computeCommitment({ ...base, ledgerHeadHash: "0x1234" })).toThrow(/head hash/);
    expect(computeCommitment({ ...base, ledgerJournalId: 0n, ledgerHeadHash: ZERO_HASH })).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("network policy", () => {
  const p = { besuChainId: 586_586, production: false, custody: "dev-file" as const };

  it("never anchors on the private chain or the dev chain ID", () => {
    expect(readProblem({ anchorChainId: 586_586, besuChainId: 586_586 })).toMatch(/586586/);
    expect(readProblem({ anchorChainId: 1234, besuChainId: 1234 })).toMatch(/differ/);
    expect(sendProblem({ ...p, anchorChainId: 586_586, allowChainId: 586_586 })).not.toBeNull();
  });

  it("allows the local stand-in only outside production", () => {
    expect(sendProblem({ ...p, anchorChainId: LOCAL_ANCHOR_CHAIN_ID })).toBeNull();
    expect(sendProblem({ ...p, anchorChainId: LOCAL_ANCHOR_CHAIN_ID, production: true })).toMatch(/production/);
  });

  it("refuses public chains unless explicitly allowed AND held by a production key provider", () => {
    for (const id of [1, 10, 137, 8453, 42_161, 11_155_111, 31_337]) {
      expect(sendProblem({ ...p, anchorChainId: id })).toMatch(/ANCHOR_ALLOW_CHAIN_ID/);
      expect(sendProblem({ ...p, anchorChainId: id, allowChainId: id + 1 })).toMatch(/ANCHOR_ALLOW_CHAIN_ID/);
      expect(sendProblem({ ...p, anchorChainId: id, allowChainId: id })).toMatch(/dev keystore/);
      expect(sendProblem({ ...p, anchorChainId: id, allowChainId: id, custody: "hsm", production: true })).toBeNull();
    }
  });
});

describe("anchor deployment from a DeployAnchor broadcast", () => {
  it("reads the address and the deployment block, and refuses a broadcast for another chain", () => {
    const dir = mkdtempSync(join(tmpdir(), "pt-anchor-"));
    const file = join(dir, "run-latest.json");
    const address = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
    writeFileSync(file, JSON.stringify({ chain: 586_650, returns: { anchor: { value: address } }, receipts: [{ blockNumber: "0x7", contractAddress: address.toLowerCase() }] }));
    expect(anchorDeploymentFromBroadcast(file, 586_650)).toEqual({ contract: address.toLowerCase(), chainId: 586_650, fromBlock: 7n });
    expect(() => anchorDeploymentFromBroadcast(file, 8453)).toThrow(/chain 586650/);
    expect(anchorDeploymentFromBroadcast(join(dir, "missing.json"), 586_650)).toBeNull();
  });
});
