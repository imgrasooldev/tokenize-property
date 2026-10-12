import { encodeFunctionData, type Hex } from "viem";
import { z } from "zod";
import { issuanceGuardAbi } from "@pt/contracts";

/**
 * Policy engine (deny by default). Each command kind has one active, versioned policy (approved
 * by a second operator, S-2). Evaluation is a pure function of the policy, the payload and facts
 * read from the chain and the database, so every decision is reproducible from the audit log.
 */

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const uint = z.string().regex(/^(0|[1-9][0-9]{0,30})$/);

export const mintRule = z.object({
  chainId: z.number().int().positive(),
  keyRef: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
  issuance: address,
  token: address,
  identityRegistry: address,
  maxPerCommand: uint,
  maxPerDay: uint,
  /** Commands above this amount need maker-checker approval. */
  approvalAbove: uint,
  approvals: z.number().int().min(1).max(5),
  /**
   * Fixed gas limit for this kind (a mint uses about 390k). Estimating per transaction costs
   * 0.7-1 s on Besu; every call is simulated before signing instead, and gas is free on the
   * private chain, so a generous fixed limit is both safe and fast.
   */
  gasLimit: z.string().regex(/^[1-9][0-9]{4,6}$/).default("800000"),
});
export type MintRule = z.infer<typeof mintRule>;

export const mintPayload = z.object({
  issuance: address,
  to: address,
  amount: z.string().regex(/^[1-9][0-9]{0,17}$/),
  refId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});
export type MintPayload = z.infer<typeof mintPayload>;

/** Facts the policy needs, read fresh for every decision. */
export interface MintFacts {
  chainId: number;
  recipientVerified: boolean;
  supply: bigint;
  cap: bigint;
  paused: boolean;
  /** Amount already signed today for this key and kind (excluding this request). */
  signedToday: bigint;
}

export type Decision =
  | { decision: "deny"; reason: string }
  | { decision: "allow"; approvalsNeeded: number; amount: bigint; keyRef: string; to: Hex; data: Hex; gas: bigint };

export const KINDS = ["issuance.mint"] as const;
export type Kind = (typeof KINDS)[number];

/**
 * Kinds that move money out or settle rent (none exist yet). Whatever their own policy says, they
 * are denied unless reconciliation allows payouts (recon.payout_gate(), ADR 0007): not frozen, and
 * the latest run passed within 26 hours. Deny by default, so a future payout kind cannot forget it.
 */
const PAYOUT_KIND = /^(payout|rent|distribution)\./;

export function isPayoutKind(kind: string): boolean {
  return PAYOUT_KIND.test(kind);
}

export function parseRule(kind: string, rule: unknown): MintRule {
  if (kind !== "issuance.mint") throw new Error(`no policy schema for kind ${kind}`);
  return mintRule.parse(rule);
}

export function evaluateMint(rule: MintRule, payload: unknown, facts: MintFacts): Decision {
  const p = mintPayload.safeParse(payload);
  if (!p.success) return { decision: "deny", reason: `malformed payload: ${p.error.issues.map((i) => i.path.join(".")).join(", ")}` };
  const { issuance, to, refId } = p.data;
  const amount = BigInt(p.data.amount);
  if (facts.chainId !== rule.chainId) return { decision: "deny", reason: `wrong chain ${String(facts.chainId)}` };
  if (issuance.toLowerCase() !== rule.issuance.toLowerCase()) return { decision: "deny", reason: "target is not the approved IssuanceGuard" };
  if (BigInt(refId) === 0n) return { decision: "deny", reason: "zero refId" };
  if (amount > BigInt(rule.maxPerCommand)) return { decision: "deny", reason: `amount ${amount.toString()} above per-command limit ${rule.maxPerCommand}` };
  if (facts.signedToday + amount > BigInt(rule.maxPerDay)) return { decision: "deny", reason: `daily limit ${rule.maxPerDay} would be exceeded` };
  if (!facts.recipientVerified) return { decision: "deny", reason: "recipient is not verified in the identity registry" };
  if (facts.paused) return { decision: "deny", reason: "token is paused" };
  if (facts.supply + amount > facts.cap) return { decision: "deny", reason: "trustee cap would be exceeded" };
  const data = encodeFunctionData({ abi: issuanceGuardAbi, functionName: "mint", args: [to as Hex, amount, refId as Hex] });
  return {
    decision: "allow",
    approvalsNeeded: amount > BigInt(rule.approvalAbove) ? rule.approvals : 0,
    amount,
    keyRef: rule.keyRef,
    to: rule.issuance.toLowerCase() as Hex,
    data,
    gas: BigInt(rule.gasLimit),
  };
}
