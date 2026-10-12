import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeLog, eventNames } from "../src/decode.ts";
import { deploymentFromBroadcast, parseDeployment } from "../src/deployment.ts";
import { diffSnapshots, ReadModel } from "../src/model.ts";
import { encode, fakeDeployment } from "./fake-chain.ts";

const ALICE = "0xa11ce00000000000000000000000000000000001";
const ROOT = `0x${"Ab".repeat(32)}` as const;

describe("decodeLog", () => {
  it("decodes ERC-3643 and custom events with normalised arguments", () => {
    const t = encode({ role: "token", name: "Transfer", args: { from: `0x${"0".repeat(40)}`, to: ALICE, value: 10n ** 30n } });
    expect(decodeLog("token", t.topics, t.data)).toEqual({
      name: "Transfer",
      args: { from: `0x${"0".repeat(40)}`, to: ALICE.toLowerCase(), value: "1000000000000000000000000000000" },
    });

    const p = encode({ role: "distributions", name: "DistributionPublished", args: {
      id: 3n, token: ALICE, recordBlock: 99n, merkleRoot: ROOT, totalPaisa: 12_345n, statementHash: ROOT,
    } });
    expect(decodeLog("distributions", p.topics, p.data)).toEqual({
      name: "DistributionPublished",
      args: { id: "3", token: ALICE.toLowerCase(), recordBlock: "99", merkleRoot: ROOT.toLowerCase(), totalPaisa: "12345", statementHash: ROOT.toLowerCase() },
    });

    // Strings keep their case; small integers stay numbers.
    const doc = encode({ role: "documents", name: "DocumentAdded", args: { id: 1n, token: ALICE, docType: 7, sha256Hash: ROOT, uri: "vault://Court/Order-0xABC.pdf" } });
    expect(decodeLog("documents", doc.topics, doc.data).args).toMatchObject({ docType: 7, uri: "vault://Court/Order-0xABC.pdf" });
  });

  it("routes by contract role: the same event name on two contracts decodes with each one's ABI", () => {
    const guard = encode({ role: "pauseGuard", name: "Paused", args: { by: ALICE, reason: "Fire drill" } });
    const token = encode({ role: "token", name: "Paused", args: { _userAddress: ALICE } });
    expect(decodeLog("pauseGuard", guard.topics, guard.data)).toEqual({ name: "Paused", args: { by: ALICE.toLowerCase(), reason: "Fire drill" } });
    expect(decodeLog("token", token.topics, token.data)).toEqual({ name: "Paused", args: { _userAddress: ALICE.toLowerCase() } });
    // A guard's Paused log is not a token event, and the other way round.
    expect(decodeLog("token", guard.topics, guard.data).name).toBeNull();
    expect(decodeLog("pauseGuard", token.topics, token.data).name).toBeNull();
  });

  it("keeps unknown or malformed logs undecoded instead of guessing", () => {
    expect(decodeLog("token", [`0x${"12".repeat(32)}`], "0x")).toEqual({ name: null, args: null });
    expect(decodeLog("token", [], "0x")).toEqual({ name: null, args: null });
    const t = encode({ role: "token", name: "Transfer", args: { from: ALICE, to: ALICE, value: 1n } });
    expect(decodeLog("token", t.topics, "0x01")).toEqual({ name: null, args: null }); // truncated data
    expect(decodeLog("token", t.topics.slice(0, 2), t.data)).toEqual({ name: null, args: null }); // missing topic
  });

  it("knows every event the read model derives from", () => {
    expect(eventNames("token")).toEqual(expect.arrayContaining(["Transfer", "Paused", "Unpaused", "AddressFrozen", "TokensFrozen", "TokensUnfrozen", "RecoverySuccess"]));
    expect(eventNames("issuance")).toEqual(expect.arrayContaining(["Minted", "Burned", "TrusteeCapSet"]));
    expect(eventNames("distributions")).toEqual(expect.arrayContaining(["DistributionPublished", "DistributionRejected", "DistributionFinalized", "PayoutRecorded"]));
    expect(eventNames("documents")).toEqual(expect.arrayContaining(["DocumentAdded", "DocumentSuperseded"]));
    expect(eventNames("freezeGuard")).toEqual(expect.arrayContaining(["AddressFreezeSet", "PartialFreezeSet"]));
    expect(eventNames("recovery")).toEqual(expect.arrayContaining(["RecoveryProposed", "RecoveryExecuted", "RecoveryCancelled"]));
    expect(eventNames("identityRegistry")).toEqual(expect.arrayContaining(["IdentityRegistered", "IdentityRemoved", "IdentityUpdated", "CountryUpdated"]));
    expect(eventNames("registrarGuard")).toContain("InvestorRegistered");
  });
});

describe("deployments", () => {
  it("validates addresses and refuses duplicates or a missing token", () => {
    expect(() => parseDeployment({ id: "x", chainId: 1, fromBlock: 0n, contracts: { issuance: ALICE } })).toThrow(/token/);
    expect(() => parseDeployment({ id: "x", chainId: 1, fromBlock: 0n, contracts: { token: ALICE, issuance: ALICE.toLowerCase() } })).toThrow(/distinct/);
    expect(() => parseDeployment({ id: "x", chainId: 1, fromBlock: 0n, contracts: { token: "0x1234" } })).toThrow(/invalid deployment/);
    expect(() => parseDeployment({ id: "Bad Id", chainId: 1, fromBlock: 0n, contracts: { token: ALICE } })).toThrow(/invalid deployment/);
    expect(parseDeployment({ id: "x", chainId: 1, fromBlock: 5n, contracts: { token: ALICE } }).contracts.token).toBe(ALICE.toLowerCase());
  });

  it("reads a DeployLib broadcast file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pt-broadcast-"));
    try {
      const addresses = Array.from({ length: 17 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
      const file = join(dir, "run-latest.json");
      writeFileSync(file, JSON.stringify({ returns: { d: { value: `(${addresses.join(", ")})` } }, receipts: [{ blockNumber: "0x3a" }] }));
      const d = deploymentFromBroadcast(file);
      expect(d).toMatchObject({ id: addresses[8], chainId: 586_586, fromBlock: 58n });
      expect(d?.contracts).toMatchObject({ timelock: addresses[0], idFactory: addresses[3], token: addresses[8], identityRegistry: addresses[9], documents: addresses[16] });
      writeFileSync(file, JSON.stringify({ returns: { d: { value: "(0x01)" } } }));
      expect(deploymentFromBroadcast(file)).toBeNull();
      expect(deploymentFromBroadcast(join(dir, "missing.json"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reference model", () => {
  it("diffSnapshots names every difference and ignores none", () => {
    const d = fakeDeployment(1n);
    const a = new ReadModel(d).snapshot();
    const b = structuredClone(a);
    expect(diffSnapshots(a, b)).toEqual([]);
    b.holdings["0xabc"] = "5";
    b.token.paused = false;
    expect(diffSnapshots(a, b)).toEqual([
      "holdings.0xabc: chain undefined vs read model \"5\"",
      "token.paused: chain true vs read model false",
    ]);
  });
});
