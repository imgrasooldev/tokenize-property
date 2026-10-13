import { encodeAbiParameters, encodeFunctionData, keccak256, type Hex } from "viem";
import { z } from "zod";
import { distributionRegistryAbi, freezeGuardAbi, idFactoryAbi, identityAbi, issuanceGuardAbi, registrarGuardAbi, tokenAbi } from "@pt/contracts";
import { custodialRef } from "./keystore.ts";

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
  /**
   * S-02 (ADR 0005 amendment 2026-10-13): when true, a mint is allowed only for a refId that
   * offering.mint_allowed() accepts: an allocation in the approved issuance batch of an offering in
   * its mint window, with the same wallet and amount and a booked, unrefunded payment. Off by
   * default so the web prototype's mints (no offering) keep working until it moves to offerings.
   */
  requireOfferingBatch: z.boolean().default(false),
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
  /** offering.mint_allowed(): why an offering refuses this mint (null = allowed); read only when the rule requires it. */
  offeringProblem?: string | null;
}

export type Decision =
  | { decision: "deny"; reason: string }
  /** amount: token units for a mint; null for kinds that move no amount (limits count requests instead). */
  | { decision: "allow"; approvalsNeeded: number; amount: bigint | null; keyRef: string; to: Hex; data: Hex; gas: bigint };

export const KINDS = [
  "issuance.mint",
  "compliance.freeze",
  "rent.record_payout",
  "token.transfer",
  "identity.create",
  "identity.add_claim",
  "identity.register",
] as const;
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

// ------------------------------------------------------------------ token.transfer (Step 5h, ADR 0010)

const ESCROW = /^web:order:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:escrow$/;
const amount18 = z.string().regex(/^[1-9][0-9]{0,17}$/);

/**
 * Delivery leg of a DvP trade on the demo market: tokens from the seller's CUSTODIAL wallet to a
 * verified buyer, only while the buyer's payment is locked in the trade's escrow (migration 0012, W-3).
 */
export const transferRule = z.object({
  chainId: z.number().int().positive(),
  token: address,
  identityRegistry: address,
  maxPerCommand: uint,
  maxPerDay: uint,
  /** Transfers above this many tokens need maker-checker approval. */
  approvalAbove: uint,
  approvals: z.number().int().min(1).max(5),
  // A transfer with the compliance modules uses about 370k; with 400k the 63/64 rule ran out of gas in a module call (found on Besu).
  gasLimit: z.string().regex(/^[1-9][0-9]{4,6}$/).default("1000000"),
});
export type TransferRule = z.infer<typeof transferRule>;

export const transferPayload = z.strictObject({
  token: address,
  from: address,
  to: address,
  amount: amount18,
  trade: z.uuid(),
  escrowAccount: z.string().regex(ESCROW),
  costPaisa: amount18,
});

export interface TransferFacts {
  chainId: number;
  /** The sender is a custodial wallet of this signing service (signer.custodial_wallets). */
  fromCustodial: boolean;
  recipientVerified: boolean;
  paused: boolean;
  senderFrozen: boolean;
  /** balanceOf(from) minus its frozen tokens. */
  freeBalance: bigint;
  /** What the trade's escrow account holds (ledger.escrow_held). */
  escrowHeld: bigint;
  /** Tokens already signed today under this kind (excluding this request). */
  signedToday: bigint;
}

export function evaluateTransfer(rule: TransferRule, payload: unknown, facts: TransferFacts): Decision {
  const p = transferPayload.safeParse(payload);
  if (!p.success) return { decision: "deny", reason: `malformed payload: ${p.error.issues.map((i) => i.path.join(".")).join(", ")}` };
  const { token, from, to } = p.data;
  const amount = BigInt(p.data.amount);
  const cost = BigInt(p.data.costPaisa);
  if (facts.chainId !== rule.chainId) return { decision: "deny", reason: `wrong chain ${String(facts.chainId)}` };
  if (token.toLowerCase() !== rule.token.toLowerCase()) return { decision: "deny", reason: "target is not the approved token" };
  if (from.toLowerCase() === to.toLowerCase()) return { decision: "deny", reason: "sender and recipient are the same wallet" };
  if (!facts.fromCustodial) return { decision: "deny", reason: "sender is not a custodial wallet of this signing service" };
  if (amount > BigInt(rule.maxPerCommand)) return { decision: "deny", reason: `amount ${amount.toString()} above per-command limit ${rule.maxPerCommand}` };
  if (facts.signedToday + amount > BigInt(rule.maxPerDay)) return { decision: "deny", reason: `daily limit ${rule.maxPerDay} would be exceeded` };
  if (!facts.recipientVerified) return { decision: "deny", reason: "recipient is not verified in the identity registry" };
  if (facts.paused) return { decision: "deny", reason: "token is paused" };
  if (facts.senderFrozen) return { decision: "deny", reason: "sender is frozen" };
  if (facts.freeBalance < amount) return { decision: "deny", reason: "sender does not hold enough unfrozen tokens" };
  if (facts.escrowHeld < cost) return { decision: "deny", reason: "the buyer's payment is not locked in escrow (delivery versus payment)" };
  return {
    decision: "allow",
    approvalsNeeded: amount > BigInt(rule.approvalAbove) ? rule.approvals : 0,
    amount,
    keyRef: custodialRef(from),
    to: rule.token.toLowerCase() as Hex,
    data: encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [to as Hex, amount] }),
    gas: BigInt(rule.gasLimit),
  };
}

// ------------------------------------------------------------------ onboarding (Step 5h, ADR 0010)

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const countRule = {
  chainId: z.number().int().positive(),
  maxPerDay: z.number().int().min(1).max(100_000),
  /** Onboarding steps are routine and gated by KYC; a policy may still require approvals. */
  approvals: z.number().int().min(0).max(5).default(0),
};

/** Facts shared by the onboarding kinds. */
export interface OnboardingFacts {
  chainId: number;
  /** The wallet is a custodial wallet of this signing service. */
  custodial: boolean;
  /** kyc.is_verified(wallet): the KYC service verified the wallet's owner (ADR 0009). */
  kycVerified: boolean;
  /** IdFactory.getIdentity(wallet); the zero address if none. */
  onChainIdentity: string;
  /** Requests of this kind signed today (excluding this request). */
  signedToday: number;
}

function onboardingDenial(rule: { chainId: number; maxPerDay: number }, wallet: string, facts: OnboardingFacts): string | null {
  if (facts.chainId !== rule.chainId) return `wrong chain ${String(facts.chainId)}`;
  if (!facts.custodial) return `wallet ${wallet.toLowerCase()} is not a custodial wallet of this signing service`;
  if (!facts.kycVerified) return "the wallet's owner is not KYC-verified";
  if (facts.signedToday + 1 > rule.maxPerDay) return `daily limit of ${String(rule.maxPerDay)} would be exceeded`;
  return null;
}

const malformed = (e: z.ZodError): Decision => ({ decision: "deny", reason: `malformed payload: ${e.issues.map((i) => i.path.join(".")).join(", ")}` });

export const identityCreateRule = z.object({
  ...countRule,
  keyRef: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
  idFactory: address,
  gasLimit: z.string().regex(/^[1-9][0-9]{4,6}$/).default("3000000"),
});
export type IdentityCreateRule = z.infer<typeof identityCreateRule>;
export const identityCreatePayload = z.strictObject({ idFactory: address, wallet: address, salt: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/) });

export function evaluateIdentityCreate(rule: IdentityCreateRule, payload: unknown, facts: OnboardingFacts): Decision {
  const p = identityCreatePayload.safeParse(payload);
  if (!p.success) return malformed(p.error);
  if (p.data.idFactory.toLowerCase() !== rule.idFactory.toLowerCase()) return { decision: "deny", reason: "target is not the approved IdFactory" };
  const denial = onboardingDenial(rule, p.data.wallet, facts);
  if (denial) return { decision: "deny", reason: denial };
  if (facts.onChainIdentity.toLowerCase() !== ZERO_ADDRESS) return { decision: "deny", reason: "the wallet already has an identity" };
  return {
    decision: "allow",
    approvalsNeeded: rule.approvals,
    amount: null,
    keyRef: rule.keyRef,
    to: rule.idFactory.toLowerCase() as Hex,
    data: encodeFunctionData({ abi: idFactoryAbi, functionName: "createIdentity", args: [p.data.wallet as Hex, p.data.salt] }),
    gas: BigInt(rule.gasLimit),
  };
}

export const identityClaimRule = z.object({
  ...countRule,
  /** The claim key (a CLAIM key of the trusted ClaimIssuer); the transaction itself is signed by the wallet. */
  claimKeyRef: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
  idFactory: address,
  claimIssuer: address,
  topics: z.array(z.number().int().min(1).max(1_000_000)).min(1).max(8),
  gasLimit: z.string().regex(/^[1-9][0-9]{4,6}$/).default("1000000"),
});
export type IdentityClaimRule = z.infer<typeof identityClaimRule>;
export const identityClaimPayload = z.strictObject({ wallet: address, identity: address, topic: z.number().int().min(1).max(1_000_000) });

/** The claim data, exactly as the contract tests and chain/flow.py use it. */
export function claimData(topic: number): Hex {
  return encodeAbiParameters([{ type: "string" }, { type: "uint256" }], ["verified", BigInt(topic)]);
}
/** What the claim key signs (EIP-191): keccak256(abi.encode(identity, topic, data)), as ONCHAINID verifies it. */
export function claimHash(identity: string, topic: number): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }], [identity as Hex, BigInt(topic), claimData(topic)]));
}
/** ONCHAINID claim id: keccak256(abi.encode(issuer, topic)). */
export function claimId(issuer: string, topic: number): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [issuer as Hex, BigInt(topic)]));
}

export function evaluateIdentityClaim(rule: IdentityClaimRule, payload: unknown, facts: OnboardingFacts & { claimSignature: Hex | null }): Decision {
  const p = identityClaimPayload.safeParse(payload);
  if (!p.success) return malformed(p.error);
  const { wallet, identity, topic } = p.data;
  if (!rule.topics.includes(topic)) return { decision: "deny", reason: `topic ${String(topic)} is not allowed` };
  const denial = onboardingDenial(rule, wallet, facts);
  if (denial) return { decision: "deny", reason: denial };
  if (facts.onChainIdentity.toLowerCase() === ZERO_ADDRESS) return { decision: "deny", reason: "the wallet has no identity yet" };
  if (facts.onChainIdentity.toLowerCase() !== identity.toLowerCase()) return { decision: "deny", reason: "identity is not the wallet's identity in the IdFactory" };
  if (!facts.claimSignature) return { decision: "deny", reason: "claim signature unavailable" };
  return {
    decision: "allow",
    approvalsNeeded: rule.approvals,
    amount: null,
    keyRef: custodialRef(wallet),
    to: identity.toLowerCase() as Hex,
    data: encodeFunctionData({
      abi: identityAbi,
      functionName: "addClaim",
      args: [BigInt(topic), 1n, rule.claimIssuer as Hex, facts.claimSignature, claimData(topic), ""],
    }),
    gas: BigInt(rule.gasLimit),
  };
}

export const identityRegisterRule = z.object({
  ...countRule,
  keyRef: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
  registrarGuard: address,
  identityRegistry: address,
  idFactory: address,
  claimIssuer: address,
  countries: z.array(z.number().int().min(1).max(999)).min(1).max(50),
  /** Every topic must hold a claim from the trusted issuer before registration. */
  topics: z.array(z.number().int().min(1).max(1_000_000)).min(1).max(8),
  gasLimit: z.string().regex(/^[1-9][0-9]{4,6}$/).default("1000000"),
});
export type IdentityRegisterRule = z.infer<typeof identityRegisterRule>;
export const identityRegisterPayload = z.strictObject({ registrarGuard: address, wallet: address, identity: address, country: z.number().int().min(1).max(999) });

export function evaluateIdentityRegister(
  rule: IdentityRegisterRule,
  payload: unknown,
  facts: OnboardingFacts & { alreadyRegistered: boolean; topicsWithClaim: number[] },
): Decision {
  const p = identityRegisterPayload.safeParse(payload);
  if (!p.success) return malformed(p.error);
  const { registrarGuard, wallet, identity, country } = p.data;
  if (registrarGuard.toLowerCase() !== rule.registrarGuard.toLowerCase()) return { decision: "deny", reason: "target is not the approved RegistrarGuard" };
  if (!rule.countries.includes(country)) return { decision: "deny", reason: `country ${String(country)} is not allowed` };
  const denial = onboardingDenial(rule, wallet, facts);
  if (denial) return { decision: "deny", reason: denial };
  if (identity.toLowerCase() === ZERO_ADDRESS || facts.onChainIdentity.toLowerCase() !== identity.toLowerCase()) {
    return { decision: "deny", reason: "identity is not the wallet's identity in the IdFactory" };
  }
  const missing = rule.topics.filter((t) => !facts.topicsWithClaim.includes(t));
  if (missing.length) return { decision: "deny", reason: `identity has no claim from the trusted issuer for topic ${missing.join(", ")}` };
  if (facts.alreadyRegistered) return { decision: "deny", reason: "wallet is already registered" };
  return {
    decision: "allow",
    approvalsNeeded: rule.approvals,
    amount: null,
    keyRef: rule.keyRef,
    to: rule.registrarGuard.toLowerCase() as Hex,
    data: encodeFunctionData({ abi: registrarGuardAbi, functionName: "register", args: [wallet as Hex, identity as Hex, country] }),
    gas: BigInt(rule.gasLimit),
  };
}

export type AnyRule = MintRule | FreezeRule | RecordPayoutRule | TransferRule | IdentityCreateRule | IdentityClaimRule | IdentityRegisterRule;

/** The key a request of this kind would be signed with (for the audit of a denial); null if unknown. */
export function requestKeyRef(kind: string, rule: AnyRule, payload: unknown): string | null {
  if ("keyRef" in rule) return rule.keyRef;
  const p = (payload ?? {}) as { from?: unknown; wallet?: unknown };
  const wallet = kind === "token.transfer" ? p.from : p.wallet;
  return typeof wallet === "string" && /^0x[0-9a-fA-F]{40}$/.test(wallet) ? custodialRef(wallet) : null;
}

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
  if (kind === "token.transfer") return transferRule.parse(rule);
  if (kind === "identity.create") return identityCreateRule.parse(rule);
  if (kind === "identity.add_claim") return identityClaimRule.parse(rule);
  if (kind === "identity.register") return identityRegisterRule.parse(rule);
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
  if (rule.requireOfferingBatch) {
    if (facts.offeringProblem === undefined) return { decision: "deny", reason: "offering fact unavailable" };
    if (facts.offeringProblem !== null) return { decision: "deny", reason: `offering: ${facts.offeringProblem}` };
  }
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
