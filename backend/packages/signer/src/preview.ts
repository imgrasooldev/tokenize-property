import { createHash } from "node:crypto";
import { decodeFunctionData, encodeFunctionData, type Abi, type Hex } from "viem";
import { distributionRegistryAbi, freezeGuardAbi, idFactoryAbi, identityAbi, issuanceGuardAbi, recoveryGuardAbi, registrarGuardAbi, tokenAbi } from "@pt/contracts";
import {
  addKeyPayload,
  proposePayload,
  requestPayload,
  walletKey,
  type AddKeyRule,
  type RecoveryRule,
  claimData,
  freezePayload,
  identityClaimPayload,
  identityCreatePayload,
  identityRegisterPayload,
  mintPayload,
  recordPayoutPayload,
  transferPayload,
  type AnyRule,
  type FreezeRule,
  type IdentityClaimRule,
  type IdentityCreateRule,
  type IdentityRegisterRule,
  type MintRule,
  type RecordPayoutRule,
  type TransferRule,
} from "./policy.ts";

/**
 * What a checker sees before deciding a signing request (Step 6b, "what you see is what you sign").
 * The call is built from the request's payload and the ACTIVE policy exactly as the policy engine
 * builds it at signing time, then the arguments shown are DECODED back from those bytes, so the
 * screen can never show something other than the calldata. callHash binds the officer's decision
 * to this exact call: the signing service recomputes it when the decision arrives and refuses a
 * decision taken on anything else (a changed policy, target or payload).
 */
export interface CallArg {
  name: string;
  type: string;
  value: string;
}

export interface CallPreview {
  version: 1;
  requestId: string;
  kind: string;
  chainId: number;
  policyId: string;
  policyVersion: number;
  /** The signing address (platform key or custodial wallet); null if the key is unknown. */
  from: Hex | null;
  to: Hex;
  contract: string;
  functionName: string;
  args: CallArg[];
  /** Exact calldata; null only for identity.add_claim (its claim signature is made at signing time). */
  data: Hex | null;
  selector: Hex;
  gasLimit: string;
  payloadHash: string;
  callHash: string;
  /** The policy rules the request is checked against (again at signing time). */
  rules: string[];
  note: string | null;
}

export class PreviewError extends Error {
  override name = "PreviewError";
}

function bad(what: string): never {
  throw new PreviewError(`the request's payload is not a valid ${what}`);
}

function decoded(abi: Abi, data: Hex): { functionName: string; args: CallArg[] } {
  const d = decodeFunctionData({ abi, data });
  const item = abi.find((x) => x.type === "function" && x.name === d.functionName && x.inputs.length === (d.args ?? []).length);
  const inputs = item && item.type === "function" ? item.inputs : [];
  const args = (d.args ?? []).map((v, i) => ({
    name: inputs.at(i)?.name ?? `arg${String(i)}`,
    type: inputs.at(i)?.type ?? "unknown",
    value: typeof v === "bigint" ? v.toString() : typeof v === "string" ? v : JSON.stringify(v),
  }));
  return { functionName: d.functionName, args };
}

const n = (x: string | number): string => BigInt(x).toLocaleString("en-US");

interface Built {
  to: Hex;
  data: Hex | null;
  abi: Abi;
  contract: string;
  /** Used when data is null (identity.add_claim). */
  manual?: { functionName: string; args: CallArg[] };
  from: Hex | null;
  gas: string;
  rules: string[];
  note?: string;
}

function build(kind: string, rule: AnyRule, payload: unknown, keyAddress: (ref: string) => Hex | null): Built {
  switch (kind) {
    case "issuance.mint": {
      const r = rule as MintRule;
      const p = mintPayload.safeParse(payload);
      if (!p.success) bad("mint");
      return {
        to: r.issuance.toLowerCase() as Hex,
        data: encodeFunctionData({ abi: issuanceGuardAbi, functionName: "mint", args: [p.data.to as Hex, BigInt(p.data.amount), p.data.refId as Hex] }),
        abi: issuanceGuardAbi,
        contract: "IssuanceGuard",
        from: keyAddress(r.keyRef),
        gas: r.gasLimit,
        rules: [
          `target is the approved IssuanceGuard ${r.issuance.toLowerCase()} (token ${r.token.toLowerCase()})`,
          "refId is non-zero and single use (the guard refuses a reused refId)",
          `amount at most ${n(r.maxPerCommand)} tokens per command and ${n(r.maxPerDay)} per day (Pakistan time)`,
          "recipient verified in the identity registry; token not paused; supply stays within the trustee cap",
          `above ${n(r.approvalAbove)} tokens: ${String(r.approvals)} approvals by different officers plus a trustee officer's co-signature (database rule, migration 0023)`,
          "the call is simulated on chain just before signing",
        ],
      };
    }
    case "token.transfer": {
      const r = rule as TransferRule;
      const p = transferPayload.safeParse(payload);
      if (!p.success) bad("transfer");
      return {
        to: r.token.toLowerCase() as Hex,
        data: encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [p.data.to as Hex, BigInt(p.data.amount)] }),
        abi: tokenAbi,
        contract: "Token (ERC-3643)",
        from: p.data.from.toLowerCase() as Hex,
        gas: r.gasLimit,
        rules: [
          `target is the approved token ${r.token.toLowerCase()}; sender is a custodial wallet of the signing service`,
          `amount at most ${n(r.maxPerCommand)} tokens per command and ${n(r.maxPerDay)} per day`,
          "recipient verified; token not paused; sender not frozen and holds enough unfrozen tokens",
          `delivery versus payment: the buyer's ${n(p.data.costPaisa)} paisa are locked in ${p.data.escrowAccount}`,
          `above ${n(r.approvalAbove)} tokens: ${String(r.approvals)} approvals by different officers`,
          "the call is simulated on chain just before signing",
        ],
      };
    }
    case "compliance.freeze": {
      const r = rule as FreezeRule;
      const p = freezePayload.safeParse(payload);
      if (!p.success) bad("freeze");
      return {
        to: r.freezeGuard.toLowerCase() as Hex,
        data: encodeFunctionData({ abi: freezeGuardAbi, functionName: "freezeAddress", args: [p.data.account as Hex, p.data.caseId as Hex] }),
        abi: freezeGuardAbi,
        contract: "FreezeGuard",
        from: keyAddress(r.keyRef),
        gas: r.gasLimit,
        rules: [
          `target is the approved FreezeGuard ${r.freezeGuard.toLowerCase()}`,
          "only for an investor who lost KYC verification; never a verified investor; not already frozen",
          `at most ${String(r.maxPerDay)} freezes per day`,
        ],
      };
    }
    case "compliance.unfreeze": {
      const r = rule as FreezeRule;
      const p = freezePayload.safeParse(payload);
      if (!p.success) bad("unfreeze");
      return {
        to: r.freezeGuard.toLowerCase() as Hex,
        data: encodeFunctionData({ abi: freezeGuardAbi, functionName: "unfreezeAddress", args: [p.data.account as Hex, p.data.caseId as Hex] }),
        abi: freezeGuardAbi,
        contract: "FreezeGuard",
        from: keyAddress(r.keyRef),
        gas: r.gasLimit,
        rules: [
          `target is the approved FreezeGuard ${r.freezeGuard.toLowerCase()}`,
          "only after two different compliance officers approved the unfreeze in the portal (compliance.unfreeze_allowed)",
          "only for a frozen wallet whose owner is KYC-verified",
          `at most ${String(r.maxPerDay)} unfreezes per day`,
        ],
      };
    }
    case "rent.record_payout": {
      const r = rule as RecordPayoutRule;
      const p = recordPayoutPayload.safeParse(payload);
      if (!p.success) bad("payout record");
      return {
        to: r.registry.toLowerCase() as Hex,
        data: encodeFunctionData({ abi: distributionRegistryAbi, functionName: "recordPayout", args: [BigInt(p.data.distributionId), p.data.payoutBatchHash as Hex] }),
        abi: distributionRegistryAbi,
        contract: "DistributionRegistry",
        from: keyAddress(r.keyRef),
        gas: r.gasLimit,
        rules: [
          `target is the approved DistributionRegistry ${r.registry.toLowerCase()} (token ${r.token.toLowerCase()})`,
          "the distribution is finalized on chain",
          "the hash is the SHA-256 of the bank file of the distribution's submitted payout batch",
          "payouts allowed by reconciliation (payout gate)",
        ],
      };
    }
    case "identity.create": {
      const r = rule as IdentityCreateRule;
      const p = identityCreatePayload.safeParse(payload);
      if (!p.success) bad("identity creation");
      return {
        to: r.idFactory.toLowerCase() as Hex,
        data: encodeFunctionData({ abi: idFactoryAbi, functionName: "createIdentity", args: [p.data.wallet as Hex, p.data.salt] }),
        abi: idFactoryAbi,
        contract: "IdFactory (ONCHAINID)",
        from: keyAddress(r.keyRef),
        gas: r.gasLimit,
        rules: ["custodial wallet of a KYC-verified investor without an identity", `at most ${String(r.maxPerDay)} per day`],
      };
    }
    case "identity.register": {
      const r = rule as IdentityRegisterRule;
      const p = identityRegisterPayload.safeParse(payload);
      if (!p.success) bad("identity registration");
      return {
        to: r.registrarGuard.toLowerCase() as Hex,
        data: encodeFunctionData({ abi: registrarGuardAbi, functionName: "register", args: [p.data.wallet as Hex, p.data.identity as Hex, p.data.country] }),
        abi: registrarGuardAbi,
        contract: "RegistrarGuard",
        from: keyAddress(r.keyRef),
        gas: r.gasLimit,
        rules: [
          `country in ${r.countries.join(", ")}; claims for topics ${r.topics.join(", ")} from the trusted issuer`,
          "KYC-verified owner; the identity is the wallet's own; not registered yet",
          `at most ${String(r.maxPerDay)} per day`,
        ],
      };
    }
    case "identity.add_claim": {
      const r = rule as IdentityClaimRule;
      const p = identityClaimPayload.safeParse(payload);
      if (!p.success) bad("identity claim");
      return {
        to: p.data.identity.toLowerCase() as Hex,
        data: null,
        abi: identityAbi,
        contract: "Identity (ONCHAINID)",
        manual: {
          functionName: "addClaim",
          args: [
            { name: "_topic", type: "uint256", value: String(p.data.topic) },
            { name: "_scheme", type: "uint256", value: "1" },
            { name: "_issuer", type: "address", value: r.claimIssuer.toLowerCase() },
            { name: "_signature", type: "bytes", value: "(made by the claim key at signing time)" },
            { name: "_data", type: "bytes", value: claimData(p.data.topic) },
            { name: "_uri", type: "string", value: "" },
          ],
        },
        from: p.data.wallet.toLowerCase() as Hex,
        gas: r.gasLimit,
        rules: [`topic in ${r.topics.join(", ")}`, "the identity is the custodial wallet's own; owner KYC-verified", `at most ${String(r.maxPerDay)} per day`],
        note: "The claim key signs the claim at signing time; the calldata exists only then.",
      };
    }
    case "recovery.freeze":
    case "recovery.unfreeze": {
      const r = rule as FreezeRule;
      const p = freezePayload.safeParse(payload);
      if (!p.success) bad(kind === "recovery.freeze" ? "case freeze" : "case unfreeze");
      const freeze = kind === "recovery.freeze";
      return {
        to: r.freezeGuard.toLowerCase() as Hex,
        data: encodeFunctionData({ abi: freezeGuardAbi, functionName: freeze ? "freezeAddress" : "unfreezeAddress", args: [p.data.account as Hex, p.data.caseId as Hex] }),
        abi: freezeGuardAbi,
        contract: "FreezeGuard",
        from: keyAddress(r.keyRef),
        gas: r.gasLimit,
        rules: [
          `target is the approved FreezeGuard ${r.freezeGuard.toLowerCase()}`,
          freeze
            ? "only the protective freeze a recovery or succession case enqueued (recovery.command_allowed); not already frozen"
            : "only after two different compliance officers released the case (recovery.command_allowed); wallet frozen; owner KYC-verified",
          `at most ${String(r.maxPerDay)} per day`,
        ],
      };
    }
    case "recovery.add_key": {
      const r = rule as AddKeyRule;
      const p = addKeyPayload.safeParse(payload);
      if (!p.success) bad("management key addition");
      return {
        to: p.data.identity.toLowerCase() as Hex,
        data: encodeFunctionData({ abi: identityAbi, functionName: "addKey", args: [walletKey(p.data.newWallet.toLowerCase()), 1n, 1n] }),
        abi: identityAbi,
        contract: "Identity (ONCHAINID)",
        from: p.data.wallet.toLowerCase() as Hex,
        gas: r.gasLimit,
        rules: [
          `adds the new wallet ${p.data.newWallet.toLowerCase()} as a MANAGEMENT key (purpose 1), signed by the old custodial wallet`,
          "only for an approved wallet-recovery case (recovery.command_allowed); identity = the old wallet's identity in the registry",
          `at most ${String(r.maxPerDay)} per day`,
        ],
      };
    }
    case "recovery.propose": {
      const r = rule as RecoveryRule;
      const p = proposePayload.safeParse(payload);
      if (!p.success) bad("recovery request");
      return {
        to: r.recoveryGuard.toLowerCase() as Hex,
        data: encodeFunctionData({
          abi: recoveryGuardAbi,
          functionName: "propose",
          args: [p.data.kind === "wallet_recovery" ? 0 : 1, p.data.from as Hex, p.data.to as Hex, p.data.onchainId as Hex, BigInt(p.data.amount), p.data.evidenceHash as Hex],
        }),
        abi: recoveryGuardAbi,
        contract: "RecoveryGuard",
        from: keyAddress(r.keyRef),
        gas: r.gasLimit,
        rules: [
          `target is the approved RecoveryGuard ${r.recoveryGuard.toLowerCase()} (token ${r.token.toLowerCase()})`,
          "only the request an approved case enqueued (recovery.command_allowed); executable after the 48-hour delay",
          p.data.kind === "wallet_recovery"
            ? "wallet recovery: identity = the old wallet's identity; new wallet unregistered; nothing else pending from the wallet"
            : `forced transfer: recipient verified; balance covers it with pending requests; recipient stays within ${n(r.maxBalance)} units`,
        ],
      };
    }
    case "recovery.execute":
    case "recovery.cancel": {
      const r = rule as RecoveryRule;
      const p = requestPayload.safeParse(payload);
      if (!p.success) bad(kind === "recovery.execute" ? "recovery execution" : "recovery cancellation");
      const execute = kind === "recovery.execute";
      return {
        to: r.recoveryGuard.toLowerCase() as Hex,
        data: encodeFunctionData({ abi: recoveryGuardAbi, functionName: execute ? "execute" : "cancel", args: [BigInt(p.data.requestId)] }),
        abi: recoveryGuardAbi,
        contract: "RecoveryGuard",
        from: keyAddress(r.keyRef),
        gas: r.gasLimit,
        rules: execute
          ? [
              "only a pending request of an approved case, after its delay (recovery.command_allowed and the chain time)",
              `checks again: recipient verified and within ${n(r.maxBalance)} units, balance, management key for a recovery`,
            ]
          : ["only a pending request of a cancelled case (objection or error)"],
      };
    }
    case "transfer.propose": {
      const r = rule as RecoveryRule;
      const p = proposePayload.safeParse(payload);
      if (!p.success || p.data.kind !== "forced_transfer") bad("transfer request");
      return {
        to: r.recoveryGuard.toLowerCase() as Hex,
        data: encodeFunctionData({
          abi: recoveryGuardAbi,
          functionName: "propose",
          args: [1, p.data.from as Hex, p.data.to as Hex, "0x0000000000000000000000000000000000000000", BigInt(p.data.amount), p.data.evidenceHash as Hex],
        }),
        abi: recoveryGuardAbi,
        contract: "RecoveryGuard",
        from: keyAddress(r.keyRef),
        gas: r.gasLimit,
        rules: [
          `target is the approved RecoveryGuard ${r.recoveryGuard.toLowerCase()} (token ${r.token.toLowerCase()})`,
          "only the ForcedTransfer an approved transfer case enqueued (transfer.command_allowed: compliance + trustee approvals, buyer's money in escrow)",
          `seller not frozen, free balance covers it with pending requests; buyer verified and stays within ${n(r.maxBalance)} units`,
        ],
      };
    }
    case "transfer.execute":
    case "transfer.cancel": {
      const r = rule as RecoveryRule;
      const p = requestPayload.safeParse(payload);
      if (!p.success) bad(kind === "transfer.execute" ? "transfer execution" : "transfer cancellation");
      const execute = kind === "transfer.execute";
      return {
        to: r.recoveryGuard.toLowerCase() as Hex,
        data: encodeFunctionData({ abi: recoveryGuardAbi, functionName: execute ? "execute" : "cancel", args: [BigInt(p.data.requestId)] }),
        abi: recoveryGuardAbi,
        contract: "RecoveryGuard",
        from: keyAddress(r.keyRef),
        gas: r.gasLimit,
        rules: execute
          ? [
              "only the case's own pending ForcedTransfer after its delay; the TR-11 checks pass again (transfer.command_allowed)",
              `seller not frozen with the free balance; buyer verified and within ${n(r.maxBalance)} units`,
            ]
          : ["only a pending request of a case that is being cancelled or failed (transfer.command_allowed)"],
      };
    }
    default:
      throw new PreviewError(`no preview for kind ${kind}`);
  }
}

/** sha256 over everything that decides what is signed (v1). */
export function callHashOf(p: Omit<CallPreview, "callHash" | "args" | "functionName" | "contract" | "rules" | "note" | "selector" | "version">): string {
  const parts = ["pt-signer-call-v1", p.requestId, p.kind, p.chainId, p.policyId, p.policyVersion, p.from, p.to, p.data, p.gasLimit, p.payloadHash];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function describeCall(input: {
  requestId: string;
  kind: string;
  payload: unknown;
  payloadHash: string;
  policy: { id: string; version: number; rule: AnyRule };
  keyAddress: (ref: string) => Hex | null;
}): CallPreview {
  const b = build(input.kind, input.policy.rule, input.payload, input.keyAddress);
  const shown = b.data ? decoded(b.abi, b.data) : (b.manual ?? { functionName: "?", args: [] });
  const selector = (b.data ? b.data.slice(0, 10) : encodeFunctionData({ abi: identityAbi, functionName: "addClaim", args: [0n, 1n, b.to, "0x", "0x", ""] }).slice(0, 10)) as Hex;
  const core = {
    requestId: input.requestId,
    kind: input.kind,
    chainId: input.policy.rule.chainId,
    policyId: input.policy.id,
    policyVersion: input.policy.version,
    from: b.from,
    to: b.to,
    data: b.data,
    gasLimit: b.gas,
    payloadHash: input.payloadHash,
  };
  return {
    version: 1,
    ...core,
    contract: b.contract,
    functionName: shown.functionName,
    args: shown.args,
    selector,
    callHash: callHashOf(core),
    rules: b.rules,
    note: b.note ?? null,
  };
}
