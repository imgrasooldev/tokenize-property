import { distributionRegistryAbi } from "@pt/contracts";
import { decodeFunctionData, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { evaluateFinalize, evaluatePublish, isPayoutKind, KINDS, parseRule, rentRule, type Decision, type RentFacts } from "../src/policy.ts";
import { describeCall } from "../src/preview.ts";

/**
 * T-022 signer kinds rent.publish and rent.finalize (migration 0032 RP-1..RP-4): pure policy
 * evaluation, deny by default, the allowed calls decoded from their calldata. The database gates
 * (ops.publish_allowed / ops.finalize_allowed) are the `problem` fact here;
 * packages/tax/test/ops-db.test.ts runs them against the real database.
 */
const A = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
const H = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const TOKEN = A(0x70);
const REGISTRY = A(0x25);
const RULE = rentRule.parse({ chainId: 586586, keyRef: "ops", registry: REGISTRY, token: TOKEN, approvals: 0 });
const publish = { registry: REGISTRY, token: TOKEN, recordBlock: "10", merkleRoot: H(0xaa), totalPaisa: "4425000", statementHash: H(0xbb), calculation: "7" };
const finalize = { registry: REGISTRY, distributionId: "3" };
const ok: RentFacts = { chainId: 586586, problem: null };
const okFinal: RentFacts = { ...ok, status: "published", token: TOKEN };
const reason = (d: Decision): string => (d.decision === "deny" ? d.reason : "allowed");

describe("rent.publish and rent.finalize", () => {
  it("are known, gated kinds with a strict rule", () => {
    expect(KINDS).toEqual(expect.arrayContaining(["rent.publish", "rent.finalize"]));
    expect(isPayoutKind("rent.publish")).toBe(true);
    expect(isPayoutKind("rent.finalize")).toBe(true);
    expect(parseRule("rent.publish", { ...RULE })).toMatchObject({ approvals: 0, gasLimit: "300000" });
    expect(() => parseRule("rent.finalize", { ...RULE, registry: "nope" })).toThrow();
  });

  it("publishes exactly the enqueued calculation as DistributionRegistry.publish", () => {
    const d = evaluatePublish(RULE, publish, ok);
    if (d.decision !== "allow") throw new Error(reason(d));
    expect(d).toMatchObject({ keyRef: "ops", to: REGISTRY, amount: null, approvalsNeeded: 0 });
    const call = decodeFunctionData({ abi: distributionRegistryAbi, data: d.data });
    expect(call.functionName).toBe("publish");
    expect(call.args).toEqual([TOKEN, 10n, H(0xaa), 4_425_000n, H(0xbb)]);
  });

  it("denies a refused, foreign, zero or malformed publication", () => {
    expect(reason(evaluatePublish(RULE, publish, { ...ok, problem: "this statement is already published on chain" }))).toMatch(/operations: this statement is already published/);
    expect(reason(evaluatePublish(RULE, publish, { ...ok, chainId: 1 }))).toMatch(/wrong chain/);
    expect(reason(evaluatePublish(RULE, { ...publish, registry: A(1) }, ok))).toMatch(/not the approved DistributionRegistry/);
    expect(reason(evaluatePublish(RULE, { ...publish, token: A(2) }, ok))).toMatch(/another token/);
    expect(reason(evaluatePublish(RULE, { ...publish, merkleRoot: H(0) }, ok))).toMatch(/zero root/);
    expect(reason(evaluatePublish(RULE, { ...publish, totalPaisa: "0" }, ok))).toMatch(/malformed/);
    expect(reason(evaluatePublish(RULE, { ...publish, extra: 1 }, ok))).toMatch(/malformed/);
  });

  it("finalises only a published distribution of this token, as DistributionRegistry.finalize", () => {
    const d = evaluateFinalize(RULE, finalize, okFinal);
    if (d.decision !== "allow") throw new Error(reason(d));
    const call = decodeFunctionData({ abi: distributionRegistryAbi, data: d.data });
    expect(call).toMatchObject({ functionName: "finalize", args: [3n] });
    expect(reason(evaluateFinalize(RULE, finalize, { ...okFinal, status: "rejected" }))).toMatch(/rejected on chain/);
    expect(reason(evaluateFinalize(RULE, finalize, { ...okFinal, token: A(2) }))).toMatch(/another token/);
    expect(reason(evaluateFinalize(RULE, finalize, { ...okFinal, problem: "the 48-hour challenge window closes at 2026-10-31" }))).toMatch(/challenge window/);
    expect(reason(evaluateFinalize(RULE, { ...finalize, distributionId: "0" }, okFinal))).toMatch(/malformed/);
  });

  it("previews the exact calls", () => {
    const base = { requestId: "00000000-0000-4000-8000-000000000001", payloadHash: "ab".repeat(32), policy: { id: "1", version: 1, rule: RULE }, keyAddress: () => A(0x99) };
    const p = describeCall({ ...base, kind: "rent.publish", payload: publish });
    expect(p).toMatchObject({ contract: "DistributionRegistry", functionName: "publish", to: REGISTRY, from: A(0x99) });
    expect(p.rules.join(" ")).toMatch(/approved calculation 7/);
    const f = describeCall({ ...base, kind: "rent.finalize", payload: finalize });
    expect(f).toMatchObject({ functionName: "finalize", to: REGISTRY });
    expect(f.rules.join(" ")).toMatch(/challenge window/);
  });
});
