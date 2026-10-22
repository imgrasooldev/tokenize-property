import { freezeGuardAbi, identityAbi, recoveryGuardAbi } from "@pt/contracts";
import { decodeFunctionData, getAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { custodialRef } from "../src/keystore.ts";
import {
  addKeyRule,
  evaluateAddKey,
  evaluateCancel,
  evaluateExecute,
  evaluatePropose,
  evaluateRecoveryFreeze,
  evaluateRecoveryUnfreeze,
  KINDS,
  parseRule,
  recoveryFreezeRule,
  recoveryRule,
  requestKeyRef,
  walletKey,
  type Decision,
  type ExecuteFacts,
  type ProposeFacts,
} from "../src/policy.ts";
import { describeCall } from "../src/preview.ts";

/**
 * S-06 signer kinds (spec S-06 section 14.6, migration 0020): pure policy evaluation, deny by
 * default, every allowed call decoded from its calldata. The database gate
 * (recovery.command_allowed) is the `allowed` fact here; recovery/test/recovery.test.ts runs the
 * same kinds against the real database.
 */
const A = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
const ZERO = A(0);
const CASE = `0x${"c1".repeat(32)}`;
const EVIDENCE = `0x${"e1".repeat(32)}`;
const FREEZE = recoveryFreezeRule.parse({ chainId: 586586, keyRef: "ops", freezeGuard: A(0xf1), token: A(2), maxPerDay: 2, approvals: 0 });
const REC = recoveryRule.parse({ chainId: 586586, keyRef: "trustee", recoveryGuard: A(0xe1), token: A(2), identityRegistry: A(3), maxBalance: "100000", maxPerDay: 3 });
const ADD = addKeyRule.parse({ chainId: 586586, identityRegistry: A(3), maxPerDay: 2 });
const OLD = A(0xa1);
const NEW = A(0xa2);
const ID = A(0x1d);

function call(d: Decision, abi: typeof freezeGuardAbi | typeof identityAbi | typeof recoveryGuardAbi) {
  if (d.decision !== "allow") throw new Error(`denied: ${d.reason}`);
  return { ...decodeFunctionData({ abi, data: d.data }), to: d.to, keyRef: d.keyRef, approvals: d.approvalsNeeded };
}
const reason = (d: Decision): string => (d.decision === "deny" ? d.reason : "allowed");

describe("kinds and rules", () => {
  it("the six kinds exist, parse their rules and refuse a rule of the wrong shape", () => {
    for (const k of ["recovery.freeze", "recovery.unfreeze", "recovery.add_key", "recovery.propose", "recovery.execute", "recovery.cancel"]) {
      expect(KINDS).toContain(k);
    }
    expect(parseRule("recovery.propose", { ...REC })).toMatchObject({ gasLimit: "2000000", approvals: 0 });
    expect(() => parseRule("recovery.propose", { ...REC, recoveryGuard: "nope" })).toThrow();
    expect(() => parseRule("recovery.add_key", { chainId: 1 })).toThrow();
    // The key of a denied add_key is the old custodial wallet's (audit of the denial).
    expect(requestKeyRef("recovery.add_key", ADD, { wallet: OLD })).toBe(custodialRef(OLD));
    expect(requestKeyRef("recovery.propose", REC, {})).toBe("trustee");
  });
});

describe("recovery.freeze / recovery.unfreeze", () => {
  const payload = { freezeGuard: A(0xf1), account: OLD, caseId: CASE };
  const facts = { chainId: 586586, allowed: true, frozen: false, ownerVerified: true, signedToday: 0 };

  it("freeze: only the case's command, not frozen, the approved guard, within the daily count", () => {
    expect(call(evaluateRecoveryFreeze(FREEZE, payload, facts), freezeGuardAbi)).toMatchObject({ functionName: "freezeAddress", args: [getAddress(OLD), CASE], to: A(0xf1), keyRef: "ops" });
    // Unlike compliance.freeze, a KYC-verified owner can be frozen (a case decided it).
    expect(reason(evaluateRecoveryFreeze(FREEZE, payload, { ...facts, allowed: false }))).toMatch(/no recovery case enqueued this freeze/);
    expect(reason(evaluateRecoveryFreeze(FREEZE, payload, { ...facts, frozen: true }))).toMatch(/already frozen/);
    expect(reason(evaluateRecoveryFreeze(FREEZE, { ...payload, freezeGuard: A(0xf2) }, facts))).toMatch(/not the approved FreezeGuard/);
    expect(reason(evaluateRecoveryFreeze(FREEZE, { ...payload, caseId: `0x${"0".repeat(64)}` }, facts))).toMatch(/zero caseId/);
    expect(reason(evaluateRecoveryFreeze(FREEZE, payload, { ...facts, chainId: 1 }))).toMatch(/wrong chain/);
    expect(reason(evaluateRecoveryFreeze(FREEZE, payload, { ...facts, signedToday: 2 }))).toMatch(/daily limit/);
    expect(reason(evaluateRecoveryFreeze(FREEZE, { ...payload, extra: "x" }, facts))).toMatch(/allowed|malformed/);
    expect(reason(evaluateRecoveryFreeze(FREEZE, { account: OLD }, facts))).toMatch(/malformed/);
  });

  it("unfreeze: a released case, a frozen wallet and a verified owner", () => {
    const frozen = { ...facts, frozen: true };
    expect(call(evaluateRecoveryUnfreeze(FREEZE, payload, frozen), freezeGuardAbi)).toMatchObject({ functionName: "unfreezeAddress", args: [getAddress(OLD), CASE] });
    expect(reason(evaluateRecoveryUnfreeze(FREEZE, payload, facts))).toMatch(/not frozen/);
    expect(reason(evaluateRecoveryUnfreeze(FREEZE, payload, { ...frozen, ownerVerified: false }))).toMatch(/not KYC-verified/);
    expect(reason(evaluateRecoveryUnfreeze(FREEZE, payload, { ...frozen, allowed: false }))).toMatch(/no recovery case enqueued this unfreeze/);
  });
});

describe("recovery.add_key", () => {
  const payload = { identity: ID, wallet: OLD, newWallet: NEW, caseId: CASE };
  const facts = { chainId: 586586, allowed: true, custodial: true, registeredIdentity: ID, keyPresent: false, signedToday: 0 };

  it("addKey(keccak256(abi.encode(newWallet)), MANAGEMENT, ECDSA) on the identity, signed by the old custodial wallet", () => {
    expect(call(evaluateAddKey(ADD, payload, facts), identityAbi)).toMatchObject({ functionName: "addKey", args: [walletKey(NEW), 1n, 1n], to: ID, keyRef: custodialRef(OLD) });
    expect(walletKey(NEW)).toBe(walletKey(NEW.toUpperCase().replace("0X", "0x")));
  });

  it("refuses without the case, a custodial key, the registry identity, or when the key exists", () => {
    expect(reason(evaluateAddKey(ADD, payload, { ...facts, allowed: false }))).toMatch(/no approved wallet-recovery case/);
    expect(reason(evaluateAddKey(ADD, payload, { ...facts, custodial: false }))).toMatch(/not a custodial wallet/);
    expect(reason(evaluateAddKey(ADD, payload, { ...facts, registeredIdentity: A(0x99) }))).toMatch(/not the old wallet's identity/);
    expect(reason(evaluateAddKey(ADD, { ...payload, identity: ZERO }, { ...facts, registeredIdentity: ZERO }))).toMatch(/not the old wallet's identity/);
    expect(reason(evaluateAddKey(ADD, payload, { ...facts, keyPresent: true }))).toMatch(/already a management key/);
    expect(reason(evaluateAddKey(ADD, { ...payload, newWallet: OLD }, facts))).toMatch(/new wallet is the old wallet/);
    expect(reason(evaluateAddKey(ADD, payload, { ...facts, signedToday: 2 }))).toMatch(/daily limit/);
  });
});

describe("recovery.propose", () => {
  const recovery = { recoveryGuard: A(0xe1), kind: "wallet_recovery", from: OLD, to: NEW, onchainId: ID, amount: "0", evidenceHash: EVIDENCE, caseId: CASE };
  const forced = { ...recovery, kind: "forced_transfer", to: A(0xb1), onchainId: ZERO, amount: "33" };
  const facts: ProposeFacts = {
    chainId: 586586, allowed: true, fromBalance: 100n, fromIdentity: ID, toRegistered: false, toVerified: true, toBalance: 0n,
    pendingFrom: { requests: 0, amount: 0n }, signedToday: 0,
  };

  it("a wallet recovery: propose(WalletRecovery, old, new, identity, 0, evidence) by the trustee key", () => {
    expect(call(evaluatePropose(REC, recovery, { ...facts, toVerified: false }), recoveryGuardAbi)).toMatchObject({
      functionName: "propose",
      args: [0, getAddress(OLD), getAddress(NEW), getAddress(ID), 0n, EVIDENCE],
      to: A(0xe1),
      keyRef: "trustee",
    });
    expect(reason(evaluatePropose(REC, { ...recovery, amount: "5" }, facts))).toMatch(/full balance/);
    expect(reason(evaluatePropose(REC, recovery, { ...facts, fromIdentity: A(0x2d) }))).toMatch(/not the old wallet's identity/);
    expect(reason(evaluatePropose(REC, recovery, { ...facts, toRegistered: true }))).toMatch(/already registered/);
    expect(reason(evaluatePropose(REC, recovery, { ...facts, pendingFrom: { requests: 1, amount: 0n } }))).toMatch(/already pending/);
    expect(reason(evaluatePropose(REC, recovery, { ...facts, fromBalance: 0n }))).toMatch(/holds no units/);
  });

  it("a forced transfer: the heir verified, the balance covers it with what is pending, the heir stays within the cap", () => {
    expect(call(evaluatePropose(REC, forced, facts), recoveryGuardAbi)).toMatchObject({ functionName: "propose", args: [1, getAddress(OLD), getAddress(A(0xb1)), ZERO, 33n, EVIDENCE] });
    expect(reason(evaluatePropose(REC, forced, { ...facts, toVerified: false }))).toMatch(/not verified/);
    expect(reason(evaluatePropose(REC, forced, { ...facts, pendingFrom: { requests: 2, amount: 68n } }))).toMatch(/does not cover/);
    expect(call(evaluatePropose(REC, forced, { ...facts, pendingFrom: { requests: 2, amount: 67n } }), recoveryGuardAbi).functionName).toBe("propose");
    expect(reason(evaluatePropose(REC, forced, { ...facts, toBalance: 99_968n }))).toMatch(/per-investor cap of 100000/);
    expect(reason(evaluatePropose(REC, { ...forced, onchainId: ID }, facts))).toMatch(/no onchainId/);
    expect(reason(evaluatePropose(REC, { ...forced, amount: "0" }, facts))).toMatch(/positive amount/);
  });

  it("deny by default: no case, another guard, zero hashes, same wallets, malformed", () => {
    expect(reason(evaluatePropose(REC, forced, { ...facts, allowed: false }))).toMatch(/no approved recovery case/);
    expect(reason(evaluatePropose(REC, { ...forced, recoveryGuard: A(0xe2) }, facts))).toMatch(/not the approved RecoveryGuard/);
    expect(reason(evaluatePropose(REC, { ...forced, evidenceHash: `0x${"0".repeat(64)}` }, facts))).toMatch(/zero evidence/);
    expect(reason(evaluatePropose(REC, { ...forced, to: OLD }, facts))).toMatch(/same wallet/);
    expect(reason(evaluatePropose(REC, { ...forced, kind: "burn" }, facts))).toMatch(/malformed/);
    expect(reason(evaluatePropose(REC, forced, { ...facts, signedToday: 3 }))).toMatch(/daily limit/);
  });
});

describe("recovery.execute / recovery.cancel", () => {
  const payload = { recoveryGuard: A(0xe1), requestId: "7", caseId: CASE };
  const now = 1_800_000_000n;
  const facts: ExecuteFacts = {
    chainId: 586586, allowed: true, chainTime: now, fromBalance: 100n, toVerified: true, toBalance: 0n, newKeyPresent: true, signedToday: 0,
    request: { kind: "forced_transfer", status: "pending", eta: now - 1n, from: OLD, to: A(0xb1), onchainId: ZERO, amount: 33n },
  };

  it("execute(id) after the delay, with the chain checks run again", () => {
    expect(call(evaluateExecute(REC, payload, facts), recoveryGuardAbi)).toMatchObject({ functionName: "execute", args: [7n], to: A(0xe1), keyRef: "trustee" });
    expect(reason(evaluateExecute(REC, payload, { ...facts, chainTime: now - 2n }))).toMatch(/recovery delay runs until/);
    expect(reason(evaluateExecute(REC, payload, { ...facts, request: { ...facts.request, status: "cancelled" } }))).toMatch(/cancelled, not pending/);
    expect(reason(evaluateExecute(REC, payload, { ...facts, toVerified: false }))).toMatch(/not verified/);
    expect(reason(evaluateExecute(REC, payload, { ...facts, fromBalance: 32n }))).toMatch(/no longer holds/);
    expect(reason(evaluateExecute(REC, payload, { ...facts, toBalance: 100_000n }))).toMatch(/per-investor cap/);
    expect(reason(evaluateExecute(REC, payload, { ...facts, allowed: false }))).toMatch(/no approved recovery case/);
    const wr = { ...facts, request: { ...facts.request, kind: "wallet_recovery" as const, to: NEW, onchainId: ID, amount: 0n }, toVerified: false };
    expect(call(evaluateExecute(REC, payload, wr), recoveryGuardAbi).functionName).toBe("execute");
    expect(reason(evaluateExecute(REC, payload, { ...wr, newKeyPresent: false }))).toMatch(/not a management key/);
    expect(reason(evaluateExecute(REC, { ...payload, requestId: "0" }, facts))).toMatch(/malformed/);
  });

  it("cancel(id) only for a pending request of a cancelled case", () => {
    const f = { chainId: 586586, allowed: true, status: "pending" as const, signedToday: 0 };
    expect(call(evaluateCancel(REC, payload, f), recoveryGuardAbi)).toMatchObject({ functionName: "cancel", args: [7n] });
    expect(reason(evaluateCancel(REC, payload, { ...f, status: "executed" }))).toMatch(/executed, not pending/);
    expect(reason(evaluateCancel(REC, payload, { ...f, allowed: false }))).toMatch(/no approved recovery case/);
  });
});

describe("preview (what you see is what you sign)", () => {
  const preview = (kind: string, rule: unknown, payload: unknown) =>
    describeCall({ requestId: "00000000-0000-4000-8000-000000000001", kind, payload, payloadHash: "ab".repeat(32), policy: { id: "p", version: 1, rule: parseRule(kind, rule) }, keyAddress: () => A(0x77) });

  it("each kind is shown decoded from the bytes it would sign", () => {
    const f = preview("recovery.freeze", FREEZE, { freezeGuard: A(0xf1), account: OLD, caseId: CASE });
    expect(f).toMatchObject({ contract: "FreezeGuard", functionName: "freezeAddress", to: A(0xf1), from: A(0x77) });
    expect(preview("recovery.unfreeze", FREEZE, { freezeGuard: A(0xf1), account: OLD, caseId: CASE }).functionName).toBe("unfreezeAddress");
    const k = preview("recovery.add_key", ADD, { identity: ID, wallet: OLD, newWallet: NEW, caseId: CASE });
    expect(k).toMatchObject({ contract: "Identity (ONCHAINID)", functionName: "addKey", to: ID, from: OLD });
    expect(k.args.map((a) => a.value)).toEqual([walletKey(NEW), "1", "1"]);
    const p = preview("recovery.propose", REC, { recoveryGuard: A(0xe1), kind: "forced_transfer", from: OLD, to: NEW, onchainId: ZERO, amount: "33", evidenceHash: EVIDENCE, caseId: CASE });
    expect(p).toMatchObject({ contract: "RecoveryGuard", functionName: "propose", to: A(0xe1) });
    expect(p.args.map((a) => a.name)).toEqual(["kind", "from", "to", "onchainId", "amount", "evidenceHash"]);
    expect(preview("recovery.execute", REC, { recoveryGuard: A(0xe1), requestId: "7", caseId: CASE }).args).toEqual([{ name: "id", type: "uint256", value: "7" }]);
    expect(preview("recovery.cancel", REC, { recoveryGuard: A(0xe1), requestId: "7", caseId: CASE }).functionName).toBe("cancel");
    expect(() => preview("recovery.cancel", REC, { recoveryGuard: A(0xe1) })).toThrow(/not a valid/);
  });
});
