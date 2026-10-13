import { encodeFunctionData, type Hex } from "viem";
import { z } from "zod";
import { distributionRegistryAbi, freezeGuardAbi, issuanceGuardAbi } from "@pt/contracts";

/**
 * Policy engine (deny by default). Each command kind has one active, versioned policy (approved
 * by a second operator, S-2). Evaluation is a pure function of the policy, the payload and facts
 * read from the chain and the database, so every decision is reproducible from the audit log.
 */

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const uint = z.string().regex(/^(0|[1-9][0-9]{0,30})$/);
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

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
  /** amount: token units for a mint; null for kinds that move no amount (limits count requests instead). */
  | { decision: "allow"; approvalsNeeded: number; amount: bigint | null; keyRef: string; to: Hex; data: Hex; gas: bigint };

export const KINDS = ["issuance.mint", "compliance.freeze", "rent.record_payout"] as const;
export type Kind = (typeof KINDS)[number];

// ------------------------------------------------------------------ compliance.freeze (Step 5h)

/**
 * Freezes the wallet of an investor who LOST their KYC verification (re-screening hit, revocation,
 * expiry: kyc_alert). It is the automated first step of offboarding (finding F-01: never rely on
 * claim revocation). A verified investor can never be frozen through this kind, and a daily count
 * limits the damage of a compromised caller.
 */
export const freezeRule = z.object({
  chainId: z.number().int().positive(),
  keyRef: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
  freezeGuard: address,
  token: address,
  maxPerDay: z.number().int().min(1).max(10_000),
  /** Protective action: 0 means no approval (like pausing); a policy may still require it. */
  approvals: z.number().int().min(0).max(5),
  gasLimit: z.string().regex(/^[1-9][0-9]{4,6}$/).default("300000"),
});
export type FreezeRule = z.infer<typeof freezeRule>;

export const freezePayload = z.object({ freezeGuard: address, account: address, caseId: bytes32 });

export interface FreezeFacts {
  chainId: number;
  alreadyFrozen: boolean;
  /** kyc.is_verified(account): true means the owner is currently verified. */
  ownerVerified: boolean;
  /** Freezes already signed today under this key (excluding this request). */
  signedToday: number;
}

export function evaluateFreeze(rule: FreezeRule, payload: unknown, facts: FreezeFacts): Decision {
  const p = freezePayload.safeParse(payload);
  if (!p.success) return { decision: "deny", reason: `malformed payload: ${p.error.issues.map((i) => i.path.join(".")).join(", ")}` };
  const { freezeGuard, account, caseId } = p.data;
  if (facts.chainId !== rule.chainId) return { decision: "deny", reason: `wrong chain ${String(facts.chainId)}` };
  if (freezeGuard.toLowerCase() !== rule.freezeGuard.toLowerCase()) return { decision: "deny", reason: "target is not the approved FreezeGuard" };
  if (BigInt(caseId) === 0n) return { decision: "deny", reason: "zero caseId" };
  if (facts.ownerVerified) return { decision: "deny", reason: "the wallet's owner is KYC-verified: automated freezes are only for investors who lost their verification" };
  if (facts.alreadyFrozen) return { decision: "deny", reason: "wallet is already frozen" };
  if (facts.signedToday + 1 > rule.maxPerDay) return { decision: "deny", reason: `daily limit of ${String(rule.maxPerDay)} freezes would be exceeded` };
  return {
    decision: "allow",
    approvalsNeeded: rule.approvals,
    amount: null,
    keyRef: rule.keyRef,
    to: rule.freezeGuard.toLowerCase() as Hex,
    data: encodeFunctionData({ abi: freezeGuardAbi, functionName: "freezeAddress", args: [account as Hex, caseId as Hex] }),
    gas: BigInt(rule.gasLimit),
  };
}

// ------------------------------------------------------------------ rent.record_payout (Step 5h)

/**
 * Records on chain that the bank paid a finalized distribution (DistributionRegistry.recordPayout).
 * The hash must be the SHA-256 of the bank file of the distribution's SUBMITTED payout batch
 * (ADR 0009), read from the bank schema, so nobody can record a payout that did not leave escrow.
 * A payout kind: the reconciliation gate applies as well (ADR 0007).
 */
export const recordPayoutRule = z.object({
  chainId: z.number().int().positive(),
  keyRef: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
  registry: address,
  token: address,
  approvals: z.number().int().min(0).max(5),
  gasLimit: z.string().regex(/^[1-9][0-9]{4,6}$/).default("200000"),
});
export type RecordPayoutRule = z.infer<typeof recordPayoutRule>;

export const recordPayoutPayload = z.object({ registry: address, distributionId: uint, payoutBatchHash: bytes32 });

export interface RecordPayoutFacts {
  chainId: number;
  /** On-chain status of the distribution: none | published | rejected | finalized | paid. */
  status: string;
  token: string;
  /** 0x SHA-256 of the bank file of the distribution's submitted batch, or null. */
  bankFileSha256: string | null;
}

export function evaluateRecordPayout(rule: RecordPayoutRule, payload: unknown, facts: RecordPayoutFacts): Decision {
  const p = recordPayoutPayload.safeParse(payload);
  if (!p.success) return { decision: "deny", reason: `malformed payload: ${p.error.issues.map((i) => i.path.join(".")).join(", ")}` };
  const { registry, distributionId, payoutBatchHash } = p.data;
  if (facts.chainId !== rule.chainId) return { decision: "deny", reason: `wrong chain ${String(facts.chainId)}` };
  if (registry.toLowerCase() !== rule.registry.toLowerCase()) return { decision: "deny", reason: "target is not the approved DistributionRegistry" };
  if (facts.token.toLowerCase() !== rule.token.toLowerCase()) return { decision: "deny", reason: "distribution belongs to another token" };
  if (facts.status !== "finalized") return { decision: "deny", reason: `distribution is ${facts.status}, not finalized` };
  if (facts.bankFileSha256 === null) return { decision: "deny", reason: "no submitted bank payout batch for this distribution" };
  if (facts.bankFileSha256.toLowerCase() !== payoutBatchHash.toLowerCase()) return { decision: "deny", reason: "hash is not the SHA-256 of the submitted bank file" };
  return {
    decision: "allow",
    approvalsNeeded: rule.approvals,
    amount: null,
    keyRef: rule.keyRef,
    to: rule.registry.toLowerCase() as Hex,
    data: encodeFunctionData({ abi: distributionRegistryAbi, functionName: "recordPayout", args: [BigInt(distributionId), payoutBatchHash as Hex] }),
    gas: BigInt(rule.gasLimit),
  };
}

export type AnyRule = MintRule | FreezeRule | RecordPayoutRule;

/**
 * Kinds that move money out or settle rent (none exist yet). Whatever their own policy says, they
 * are denied unless reconciliation allows payouts (recon.payout_gate(), ADR 0007): not frozen, and
 * the latest run passed within 26 hours. Deny by default, so a future payout kind cannot forget it.
 */
const PAYOUT_KIND = /^(payout|rent|distribution)\./;

export function isPayoutKind(kind: string): boolean {
  return PAYOUT_KIND.test(kind);
}

export function parseRule(kind: "issuance.mint", rule: unknown): MintRule;
export function parseRule(kind: string, rule: unknown): AnyRule;
export function parseRule(kind: string, rule: unknown): AnyRule {
  if (kind === "issuance.mint") return mintRule.parse(rule);
  if (kind === "compliance.freeze") return freezeRule.parse(rule);
  if (kind === "rent.record_payout") return recordPayoutRule.parse(rule);
  throw new Error(`no policy schema for kind ${kind}`);
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
