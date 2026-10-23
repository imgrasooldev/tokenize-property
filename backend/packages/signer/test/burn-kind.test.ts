import { issuanceGuardAbi } from "@pt/contracts";
import { decodeFunctionData, getAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { redemptionRefId as exitRefId } from "../../exit/src/refid.ts";
import { burnRule, evaluateBurn, isPayoutKind, KINDS, parseRule, redemptionRefId, type BurnFacts, type Decision } from "../src/policy.ts";
import { describeCall } from "../src/preview.ts";

/**
 * S-05 signer kind issuance.burn (migration 0027 EX-DB-5): pure policy evaluation, deny by default,
 * the allowed call decoded from its calldata. The database gate (exit.burn_allowed) is the `exit`
 * fact here; packages/exit/test/exit-rules.test.ts runs the kind against the real database.
 */
const A = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
const TOKEN = A(0x70);
const GUARD = A(0x15);
const WALLET = A(0xa1);
const RULE = burnRule.parse({ chainId: 586586, keyRef: "issuance", issuance: GUARD, token: TOKEN, maxPerCommand: "1000", maxPerDay: 2 });
const REF = redemptionRefId(TOKEN, "7", WALLET);
const payload = { issuance: GUARD, from: WALLET, amount: "600", refId: REF };
const facts: BurnFacts = { chainId: 586586, exit: { problem: null, token: TOKEN, distributionId: "7" }, balance: 600n, signedToday: 0 };
const reason = (d: Decision): string => (d.decision === "deny" ? d.reason : "allowed");

describe("issuance.burn", () => {
  it("is a known, gated kind with a strict rule", () => {
    expect(KINDS).toContain("issuance.burn");
    expect(isPayoutKind("issuance.burn")).toBe(true);
    expect(isPayoutKind("issuance.mint")).toBe(false);
    expect(parseRule("issuance.burn", { ...RULE })).toMatchObject({ approvals: 0, gasLimit: "600000" });
    expect(() => parseRule("issuance.burn", { ...RULE, issuance: "nope" })).toThrow();
  });

  it("derives the refId exactly as the exit service does", () => {
    expect(REF).toBe(exitRefId(TOKEN, 7n, WALLET));
    expect(redemptionRefId(TOKEN.toUpperCase().replace("0X", "0x"), "7", WALLET)).toBe(REF);
    expect(redemptionRefId(TOKEN, "8", WALLET)).not.toBe(REF);
  });

  it("allows exactly the enqueued burn and encodes IssuanceGuard.burn(wallet, amount, refId)", () => {
    const d = evaluateBurn(RULE, payload, facts);
    if (d.decision !== "allow") throw new Error(reason(d));
    const call = decodeFunctionData({ abi: issuanceGuardAbi, data: d.data });
    expect(call).toMatchObject({ functionName: "burn", args: [getAddress(WALLET), 600n, REF] });
    expect(d).toMatchObject({ to: GUARD, keyRef: "issuance", approvalsNeeded: 0, amount: 600n, gas: 600000n });
  });

  it("denies everything else", () => {
    expect(reason(evaluateBurn(RULE, payload, { ...facts, exit: { problem: "the redemption batch is not approved", token: TOKEN, distributionId: "7" } })))
      .toMatch(/exit: the redemption batch is not approved/);
    expect(reason(evaluateBurn(RULE, payload, { ...facts, exit: { problem: null, token: null, distributionId: null } }))).toMatch(/no redemption batch facts/);
    expect(reason(evaluateBurn(RULE, payload, { ...facts, exit: { problem: null, token: A(0x71), distributionId: "7" } }))).toMatch(/another token/);
    expect(reason(evaluateBurn(RULE, payload, { ...facts, exit: { problem: null, token: TOKEN, distributionId: "8" } }))).toMatch(/refId is not keccak256/);
    expect(reason(evaluateBurn(RULE, { ...payload, from: A(0xa2) }, facts))).toMatch(/refId is not keccak256/);
    expect(reason(evaluateBurn(RULE, { ...payload, issuance: A(0x16) }, facts))).toMatch(/not the approved IssuanceGuard/);
    expect(reason(evaluateBurn(RULE, { ...payload, refId: `0x${"0".repeat(64)}` }, facts))).toMatch(/zero refId/);
    expect(reason(evaluateBurn(RULE, { ...payload, amount: "1001" }, facts))).toMatch(/per-command limit/);
    expect(reason(evaluateBurn(RULE, payload, { ...facts, balance: 599n }))).toMatch(/does not hold/);
    expect(reason(evaluateBurn(RULE, payload, { ...facts, signedToday: 2 }))).toMatch(/daily limit/);
    expect(reason(evaluateBurn(RULE, payload, { ...facts, chainId: 1 }))).toMatch(/wrong chain/);
    expect(reason(evaluateBurn(RULE, { ...payload, extra: 1 }, facts))).toMatch(/malformed/);
    expect(reason(evaluateBurn(RULE, { ...payload, amount: "0" }, facts))).toMatch(/malformed/);
  });

  it("previews the exact call", () => {
    const p = describeCall({ requestId: "00000000-0000-4000-8000-000000000001", kind: "issuance.burn", payload, payloadHash: "ab".repeat(32),
      policy: { id: "1", version: 1, rule: RULE }, keyAddress: () => A(0x99) });
    expect(p).toMatchObject({ contract: "IssuanceGuard", functionName: "burn", to: GUARD, from: A(0x99) });
    expect(p.args.map((x) => x.value)).toEqual([getAddress(WALLET), "600", REF]);
    expect(p.rules.join(" ")).toMatch(/exit.burn_allowed/);
  });
});
