import { recoveryGuardAbi } from "@pt/contracts";
import { decodeFunctionData, getAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  evaluateTransferCancel,
  evaluateTransferExecute,
  evaluateTransferPropose,
  KINDS,
  parseRule,
  requestKeyRef,
  transferRecoveryRule,
  type ChainRequest,
  type Decision,
  type TransferExecuteFacts,
  type TransferProposeFacts,
} from "../src/policy.ts";
import { describeCall } from "../src/preview.ts";

/**
 * S-04 phase 0 signer kinds (spec S-04 section 16.1, migration 0028): pure policy evaluation, deny
 * by default, every allowed call decoded from its calldata. The database gate (transfer.command_allowed)
 * is the `allowed` fact here; transfer/test/transfer.test.ts runs the same kinds against the real database.
 */
const A = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
const ZERO = A(0);
const CASE = `0x${"c4".repeat(32)}`;
const EVIDENCE = `0x${"e4".repeat(32)}`;
const RULE = transferRecoveryRule.parse({ chainId: 586586, keyRef: "trustee", recoveryGuard: A(0xe1), token: A(2), identityRegistry: A(3), maxBalance: "100000", maxPerDay: 3 });
const SELLER = A(0xa1);
const BUYER = A(0xb1);

function call(d: Decision) {
  if (d.decision !== "allow") throw new Error(`denied: ${d.reason}`);
  return { ...decodeFunctionData({ abi: recoveryGuardAbi, data: d.data }), to: d.to, keyRef: d.keyRef, approvals: d.approvalsNeeded };
}
const reason = (d: Decision): string => (d.decision === "deny" ? d.reason : "allowed");

describe("kinds and rules", () => {
  it("the three kinds exist with the RecoveryGuard rule shape; the key is the Trustee key", () => {
    for (const k of ["transfer.propose", "transfer.execute", "transfer.cancel"]) expect(KINDS).toContain(k);
    expect(parseRule("transfer.propose", { ...RULE })).toMatchObject({ gasLimit: "2000000", approvals: 0 });
    expect(() => parseRule("transfer.execute", { ...RULE, maxBalance: "lots" })).toThrow();
    expect(requestKeyRef("transfer.propose", RULE, {})).toBe("trustee");
  });
});

describe("transfer.propose", () => {
  const payload = { recoveryGuard: A(0xe1), kind: "forced_transfer", from: SELLER, to: BUYER, onchainId: ZERO, amount: "100", evidenceHash: EVIDENCE, caseId: CASE };
  const facts: TransferProposeFacts = {
    chainId: 586586, allowed: true, fromBalance: 1000n, fromFrozen: false, frozenTokens: 0n, toVerified: true, toBalance: 0n,
    pendingFrom: { requests: 0, amount: 0n }, signedToday: 0,
  };

  it("allows exactly the case's ForcedTransfer: propose(1, from, to, 0x0, units, evidence) to the approved guard with the trustee key", () => {
    expect(call(evaluateTransferPropose(RULE, payload, facts))).toMatchObject({
      functionName: "propose", args: [1, getAddress(SELLER), getAddress(BUYER), ZERO, 100n, EVIDENCE], to: A(0xe1), keyRef: "trustee", approvals: 0 });
  });

  it("denies by default: not the case's command, wrong chain or guard, a wallet recovery, frozen or short seller, unverified or capped buyer", () => {
    expect(reason(evaluateTransferPropose(RULE, payload, { ...facts, allowed: false }))).toMatch(/no approved transfer case enqueued/);
    expect(reason(evaluateTransferPropose(RULE, payload, { ...facts, chainId: 1 }))).toMatch(/wrong chain/);
    expect(reason(evaluateTransferPropose(RULE, { ...payload, recoveryGuard: A(0xe2) }, facts))).toMatch(/not the approved RecoveryGuard/);
    expect(reason(evaluateTransferPropose(RULE, { ...payload, caseId: `0x${"0".repeat(64)}` }, facts))).toMatch(/zero caseId/);
    expect(reason(evaluateTransferPropose(RULE, { ...payload, kind: "wallet_recovery" }, facts))).toMatch(/always a ForcedTransfer/);
    expect(reason(evaluateTransferPropose(RULE, { ...payload, onchainId: A(9) }, facts))).toMatch(/no onchainId/);
    expect(reason(evaluateTransferPropose(RULE, { ...payload, amount: "0" }, facts))).toMatch(/positive amount/);
    expect(reason(evaluateTransferPropose(RULE, { ...payload, to: SELLER }, facts))).toMatch(/same wallet/);
    expect(reason(evaluateTransferPropose(RULE, { ...payload, evidenceHash: `0x${"0".repeat(64)}` }, facts))).toMatch(/zero evidence/);
    expect(reason(evaluateTransferPropose(RULE, payload, { ...facts, fromFrozen: true }))).toMatch(/frozen/);
    expect(reason(evaluateTransferPropose(RULE, payload, { ...facts, toVerified: false }))).toMatch(/not verified/);
    // Free balance: frozen tokens and pending requests count against it.
    expect(reason(evaluateTransferPropose(RULE, payload, { ...facts, frozenTokens: 950n }))).toMatch(/free balance/);
    expect(reason(evaluateTransferPropose(RULE, payload, { ...facts, pendingFrom: { requests: 1, amount: 901n } }))).toMatch(/free balance/);
    expect(reason(evaluateTransferPropose(RULE, payload, { ...facts, toBalance: 99_901n }))).toMatch(/per-investor cap/);
    expect(reason(evaluateTransferPropose(RULE, payload, { ...facts, signedToday: 3 }))).toMatch(/daily limit/);
    expect(reason(evaluateTransferPropose(RULE, { ...payload, extra: "x" }, facts))).toMatch(/malformed/);
    expect(reason(evaluateTransferPropose(RULE, { from: SELLER }, facts))).toMatch(/malformed/);
  });
});

describe("transfer.execute and transfer.cancel", () => {
  const payload = { recoveryGuard: A(0xe1), requestId: "7", caseId: CASE };
  const request: ChainRequest = { kind: "forced_transfer", status: "pending", eta: 1_000n, from: SELLER, to: BUYER, onchainId: ZERO, amount: 100n };
  const facts: TransferExecuteFacts = {
    chainId: 586586, allowed: true, request, chainTime: 1_000n, fromBalance: 100n, fromFrozen: false, frozenTokens: 0n, toVerified: true, toBalance: 0n, signedToday: 0,
  };

  it("execute: the pending ForcedTransfer after its delay, the chain checks again; calldata execute(id)", () => {
    expect(call(evaluateTransferExecute(RULE, payload, facts))).toMatchObject({ functionName: "execute", args: [7n], to: A(0xe1), keyRef: "trustee" });
    expect(reason(evaluateTransferExecute(RULE, payload, { ...facts, allowed: false }))).toMatch(/no approved transfer case/);
    expect(reason(evaluateTransferExecute(RULE, payload, { ...facts, chainTime: 999n }))).toMatch(/delay runs until/);
    expect(reason(evaluateTransferExecute(RULE, payload, { ...facts, request: { ...request, status: "cancelled" } }))).toMatch(/not pending/);
    expect(reason(evaluateTransferExecute(RULE, payload, { ...facts, request: { ...request, kind: "wallet_recovery" } }))).toMatch(/not a ForcedTransfer/);
    expect(reason(evaluateTransferExecute(RULE, payload, { ...facts, fromFrozen: true }))).toMatch(/frozen/);
    expect(reason(evaluateTransferExecute(RULE, payload, { ...facts, frozenTokens: 1n }))).toMatch(/free balance/);
    expect(reason(evaluateTransferExecute(RULE, payload, { ...facts, toVerified: false }))).toMatch(/not verified/);
    expect(reason(evaluateTransferExecute(RULE, payload, { ...facts, toBalance: 99_901n }))).toMatch(/per-investor cap/);
  });

  it("cancel: only a pending request of a case that needs it; calldata cancel(id)", () => {
    const f = { chainId: 586586, allowed: true, status: "pending" as const, signedToday: 0 };
    expect(call(evaluateTransferCancel(RULE, payload, f))).toMatchObject({ functionName: "cancel", args: [7n], keyRef: "trustee" });
    expect(reason(evaluateTransferCancel(RULE, payload, { ...f, allowed: false }))).toMatch(/no approved transfer case/);
    expect(reason(evaluateTransferCancel(RULE, payload, { ...f, status: "executed" }))).toMatch(/not pending/);
  });

  it("the approvals inbox preview shows the same calldata the policy signs", () => {
    const p = { recoveryGuard: A(0xe1), kind: "forced_transfer", from: SELLER, to: BUYER, onchainId: ZERO, amount: "100", evidenceHash: EVIDENCE, caseId: CASE };
    const allow = evaluateTransferPropose(RULE, p, {
      chainId: 586586, allowed: true, fromBalance: 1000n, fromFrozen: false, frozenTokens: 0n, toVerified: true, toBalance: 0n, pendingFrom: { requests: 0, amount: 0n }, signedToday: 0 });
    if (allow.decision !== "allow") throw new Error("expected allow");
    const preview = describeCall({ requestId: "00000000-0000-4000-8000-000000000001", kind: "transfer.propose", payload: p, payloadHash: "ab".repeat(32),
      policy: { id: "1", version: 1, rule: RULE }, keyAddress: () => A(0x77) });
    expect(preview.data).toBe(allow.data);
    expect(preview.functionName).toBe("propose");
  });
});
