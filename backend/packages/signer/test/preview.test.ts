import { describe, expect, it } from "vitest";
import { describeCall } from "../src/preview.ts";
import {
  evaluateFreeze,
  evaluateIdentityCreate,
  evaluateIdentityRegister,
  evaluateMint,
  evaluateRecordPayout,
  evaluateTransfer,
  evaluateUnfreeze,
  type AnyRule,
  type Decision,
  type FreezeRule,
  type IdentityCreateRule,
  type IdentityRegisterRule,
  type MintRule,
  type RecordPayoutRule,
  type TransferRule,
} from "../src/policy.ts";

/**
 * "What you see is what you sign" (Step 6b): the call shown to a checker is byte-for-byte the call
 * the policy engine signs, its arguments are decoded from those bytes, and the call hash changes
 * with anything that decides what is signed.
 */
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const KEY = A(0xabc) as `0x${string}`;
const show = (kind: string, rule: AnyRule, payload: unknown, policy = { id: "7", version: 3 }) =>
  describeCall({ requestId: "11111111-1111-4111-8111-111111111111", kind, payload, payloadHash: "aa".repeat(32), policy: { ...policy, rule }, keyAddress: () => KEY });

function allowed(d: Decision): { to: string; data: string; gas: bigint } {
  if (d.decision !== "allow") throw new Error(`denied: ${d.reason}`);
  return d;
}

const mintRule: MintRule = { chainId: 586586, keyRef: "issuance", issuance: A(1), token: A(2), identityRegistry: A(3), maxPerCommand: "100000", maxPerDay: "300000", approvalAbove: "10000", approvals: 2, gasLimit: "800000", requireOfferingBatch: false };
const transferRule: TransferRule = { chainId: 586586, token: A(2), identityRegistry: A(3), maxPerCommand: "100000", maxPerDay: "1000000", approvalAbove: "10000", approvals: 2, gasLimit: "1000000" };
const freezeRule: FreezeRule = { chainId: 586586, keyRef: "ops", freezeGuard: A(4), token: A(2), maxPerDay: 20, approvals: 1, gasLimit: "300000" };
const payoutRule: RecordPayoutRule = { chainId: 586586, keyRef: "ops", registry: A(5), token: A(2), approvals: 1, gasLimit: "200000" };
const createRule: IdentityCreateRule = { chainId: 586586, keyRef: "identity", idFactory: A(6), maxPerDay: 500, approvals: 1, gasLimit: "3000000" };
const registerRule: IdentityRegisterRule = { chainId: 586586, keyRef: "registrar", registrarGuard: A(7), identityRegistry: A(3), idFactory: A(6), claimIssuer: A(8), countries: [586], topics: [1, 2], maxPerDay: 500, approvals: 1, gasLimit: "1000000" };

describe("call preview", () => {
  it("equals the calldata the policy engine signs, for every kind with deterministic calldata", () => {
    const mint = { issuance: A(1), to: A(9), amount: "20000", refId: H(5) };
    const m = allowed(evaluateMint(mintRule, mint, { chainId: 586586, recipientVerified: true, supply: 0n, cap: 1_000_000n, paused: false, signedToday: 0n }));
    expect(show("issuance.mint", mintRule, mint)).toMatchObject({ to: m.to, data: m.data, gasLimit: "800000", from: KEY, functionName: "mint" });

    const transfer = { token: A(2), from: A(10), to: A(11), amount: "15000", trade: "22222222-2222-4222-8222-222222222222", escrowAccount: "web:order:33333333-3333-4333-8333-333333333333:escrow", costPaisa: "500" };
    const t = allowed(evaluateTransfer(transferRule, transfer, { chainId: 586586, fromCustodial: true, recipientVerified: true, paused: false, senderFrozen: false, freeBalance: 10n ** 9n, escrowHeld: 500n, signedToday: 0n }));
    expect(show("token.transfer", transferRule, transfer)).toMatchObject({ to: t.to, data: t.data, from: A(10), functionName: "transfer" });

    const freeze = { freezeGuard: A(4), account: A(12), caseId: H(9) };
    const f = allowed(evaluateFreeze(freezeRule, freeze, { chainId: 586586, alreadyFrozen: false, ownerVerified: false, signedToday: 0 }));
    expect(show("compliance.freeze", freezeRule, freeze)).toMatchObject({ to: f.to, data: f.data, functionName: "freezeAddress" });
    const u = allowed(evaluateUnfreeze(freezeRule, freeze, { chainId: 586586, frozen: true, ownerVerified: true, decided: true, signedToday: 0 }));
    expect(show("compliance.unfreeze", freezeRule, freeze)).toMatchObject({ to: u.to, data: u.data, functionName: "unfreezeAddress" });

    const payout = { registry: A(5), distributionId: "4", payoutBatchHash: H(77) };
    const p = allowed(evaluateRecordPayout(payoutRule, payout, { chainId: 586586, status: "finalized", token: A(2), bankFileSha256: H(77) }));
    expect(show("rent.record_payout", payoutRule, payout)).toMatchObject({ to: p.to, data: p.data, functionName: "recordPayout" });

    const facts = { chainId: 586586, custodial: true, kycVerified: true, onChainIdentity: "0x0000000000000000000000000000000000000000", signedToday: 0 };
    const create = { idFactory: A(6), wallet: A(13), salt: "inv-1" };
    const c = allowed(evaluateIdentityCreate(createRule, create, facts));
    expect(show("identity.create", createRule, create)).toMatchObject({ to: c.to, data: c.data, functionName: "createIdentity" });

    const register = { registrarGuard: A(7), wallet: A(13), identity: A(14), country: 586 };
    const r = allowed(evaluateIdentityRegister(registerRule, register, { ...facts, onChainIdentity: A(14), alreadyRegistered: false, topicsWithClaim: [1, 2] }));
    expect(show("identity.register", registerRule, register)).toMatchObject({ to: r.to, data: r.data, functionName: "register" });
  });

  it("decodes the arguments from the bytes and names them", () => {
    const c = show("issuance.mint", mintRule, { issuance: A(1), to: A(9), amount: "20000", refId: H(5) });
    expect(c.args.map((a) => [a.name, a.type, a.value.toLowerCase()])).toEqual([
      ["to", "address", A(9)],
      ["amount", "uint256", "20000"],
      ["refId", "bytes32", H(5)],
    ]);
    expect(c.selector).toBe(c.data?.slice(0, 10));
    expect(c.rules.join(" ")).toMatch(/10,000 tokens: 2 approvals/);
  });

  it("the call hash changes with the policy, the payload, the target and the request", () => {
    const mint = { issuance: A(1), to: A(9), amount: "20000", refId: H(5) };
    const base = show("issuance.mint", mintRule, mint).callHash;
    expect(show("issuance.mint", mintRule, mint).callHash).toBe(base);
    expect(show("issuance.mint", mintRule, mint, { id: "8", version: 4 }).callHash).not.toBe(base);
    expect(show("issuance.mint", mintRule, { ...mint, amount: "20001" }).callHash).not.toBe(base);
    expect(show("issuance.mint", { ...mintRule, issuance: A(99) }, mint).callHash).not.toBe(base);
    expect(show("issuance.mint", { ...mintRule, gasLimit: "900000" }, mint).callHash).not.toBe(base);
  });

  it("a claim shows its call without the signature that only exists at signing time", () => {
    const claimRule = { chainId: 586586, claimKeyRef: "claims", idFactory: A(6), claimIssuer: A(8), topics: [1, 2], maxPerDay: 1000, approvals: 0, gasLimit: "1000000" };
    const c = show("identity.add_claim", claimRule, { wallet: A(13), identity: A(14), topic: 1 });
    expect(c).toMatchObject({ data: null, functionName: "addClaim", to: A(14), from: A(13) });
    expect(c.note).toMatch(/signing time/);
  });

  it("refuses a payload that does not match its kind", () => {
    expect(() => show("issuance.mint", mintRule, { to: "nope" })).toThrow(/not a valid mint/);
  });
});
