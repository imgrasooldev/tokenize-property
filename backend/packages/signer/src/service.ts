import { createHash } from "node:crypto";
import type pg from "pg";
import { createPublicClient, http, keccak256, type Hex } from "viem";
import { distributionRegistryAbi, idFactoryAbi, identityAbi, identityRegistryAbi, issuanceGuardAbi, tokenAbi } from "@pt/contracts";
import { z } from "zod";
import { custodialRef, type CustodyProvider, type KeyProvider } from "./keystore.ts";
import {
  claimHash,
  claimId,
  evaluateFreeze,
  evaluateIdentityClaim,
  evaluateIdentityCreate,
  evaluateIdentityRegister,
  evaluateMint,
  evaluateRecordPayout,
  evaluateTransfer,
  freezePayload,
  identityClaimPayload,
  identityCreatePayload,
  identityRegisterPayload,
  isPayoutKind,
  KINDS,
  mintPayload,
  parseRule,
  recordPayoutPayload,
  requestKeyRef,
  transferPayload,
  type AnyRule,
  type Decision,
  type FreezeRule,
  type IdentityClaimRule,
  type IdentityCreateRule,
  type IdentityRegisterRule,
  type MintRule,
  type OnboardingFacts,
  type RecordPayoutRule,
  type TransferRule,
} from "./policy.ts";

/**
 * Signing service (Step 5d). The only component that can sign platform transactions:
 *  - every request is checked against the active policy for its kind (deny by default);
 *  - requests above a policy threshold wait for maker-checker approval by distinct operators;
 *  - nonces are reserved per signing address in the database (no duplicates, no gaps);
 *  - every step is written to the hash-chained audit log;
 *  - it signs but never broadcasts: the caller records the transaction first (outbox O-5), then
 *    broadcasts and reports back (broadcast / release).
 */

export interface ChainReader {
  chainId(): Promise<number>;
  pendingNonce(address: Hex): Promise<bigint>;
  /** Simulates the call from `from`; throws with the revert reason if it would fail. */
  simulate(from: Hex, to: Hex, data: Hex): Promise<void>;
  mintFacts(rule: MintRule, to: Hex): Promise<{ recipientVerified: boolean; supply: bigint; cap: bigint; paused: boolean }>;
  /** Whether the token already freezes this wallet. */
  isFrozen(rule: FreezeRule, account: Hex): Promise<boolean>;
  /** A distribution's on-chain status (none | published | rejected | finalized | paid) and token. */
  distribution(rule: RecordPayoutRule, id: bigint): Promise<{ status: string; token: string }>;
  /** "dropped" only when there is no receipt and the sender's mined nonce is past this one. */
  txState(hash: Hex, from: Hex, nonce: bigint): Promise<"mined" | "dropped" | "pending">;
  /** Facts for a DvP delivery (token.transfer). Optional so older test doubles keep compiling. */
  transferFacts?: (rule: TransferRule, from: Hex, to: Hex) => Promise<{ recipientVerified: boolean; paused: boolean; senderFrozen: boolean; freeBalance: bigint }>;
  /** IdFactory.getIdentity(wallet) (zero address if none). */
  identityOf?: (idFactory: Hex, wallet: Hex) => Promise<string>;
  /** IdentityRegistry.contains(wallet). */
  isRegistered?: (identityRegistry: Hex, wallet: Hex) => Promise<boolean>;
  /** Issuer of the claim with this id on the identity (zero address if none). */
  claimIssuerOf?: (identity: Hex, claimId: Hex) => Promise<string>;
}

/** A chain reader without the optional onboarding/transfer facts denies those kinds (fail closed). */
function need<T>(f: T | undefined, what: string): T {
  if (f === undefined) throw new Error(`chain reader cannot read ${what}`);
  return f;
}

export function viemChainReader(rpcUrl: string): ChainReader {
  const c = createPublicClient({ transport: http(rpcUrl, { timeout: 10_000 }), pollingInterval: 250 });
  let chainId: Promise<number> | null = null; // the node cannot change chains under us
  return {
    chainId: () => (chainId ??= c.getChainId().catch((e: unknown) => {
      chainId = null;
      throw e;
    })),
    pendingNonce: async (a) => BigInt(await c.getTransactionCount({ address: a, blockTag: "pending" })),
    simulate: async (from, to, data) => {
      await c.call({ account: from, to, data });
    },
    txState: async (hash, from, nonce) => {
      const receipt = await c.getTransactionReceipt({ hash }).catch(() => null);
      if (receipt) return "mined";
      const mined = BigInt(await c.getTransactionCount({ address: from, blockTag: "latest" }));
      return mined > nonce ? "dropped" : "pending";
    },
    mintFacts: async (rule, to) => {
      const [recipientVerified, supply, cap, paused] = await Promise.all([
        c.readContract({ address: rule.identityRegistry as Hex, abi: identityRegistryAbi, functionName: "isVerified", args: [to] }),
        c.readContract({ address: rule.token as Hex, abi: tokenAbi, functionName: "totalSupply" }),
        c.readContract({ address: rule.issuance as Hex, abi: issuanceGuardAbi, functionName: "trusteeCap" }),
        c.readContract({ address: rule.token as Hex, abi: tokenAbi, functionName: "paused" }),
      ]);
      return { recipientVerified, supply, cap, paused };
    },
    isFrozen: (rule, account) => c.readContract({ address: rule.token as Hex, abi: tokenAbi, functionName: "isFrozen", args: [account] }),
    transferFacts: async (rule, from, to) => {
      const token = rule.token as Hex;
      const [recipientVerified, paused, senderFrozen, balance, frozen] = await Promise.all([
        c.readContract({ address: rule.identityRegistry as Hex, abi: identityRegistryAbi, functionName: "isVerified", args: [to] }),
        c.readContract({ address: token, abi: tokenAbi, functionName: "paused" }),
        c.readContract({ address: token, abi: tokenAbi, functionName: "isFrozen", args: [from] }),
        c.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [from] }),
        c.readContract({ address: token, abi: tokenAbi, functionName: "getFrozenTokens", args: [from] }),
      ]);
      return { recipientVerified, paused, senderFrozen, freeBalance: balance - frozen };
    },
    identityOf: async (idFactory, wallet) => (await c.readContract({ address: idFactory, abi: idFactoryAbi, functionName: "getIdentity", args: [wallet] })).toLowerCase(),
    isRegistered: (registry, wallet) => c.readContract({ address: registry, abi: identityRegistryAbi, functionName: "contains", args: [wallet] }),
    claimIssuerOf: async (identity, id) => {
      const claim = await c.readContract({ address: identity, abi: identityAbi, functionName: "getClaim", args: [id] });
      return claim[2].toLowerCase();
    },
    distribution: async (rule, id) => {
      const d = await c.readContract({ address: rule.registry as Hex, abi: distributionRegistryAbi, functionName: "getDistribution", args: [id] });
      return { status: DISTRIBUTION_STATUS[d.status] ?? "unknown", token: d.token.toLowerCase() };
    },
  };
}

const DISTRIBUTION_STATUS = ["none", "published", "rejected", "finalized", "paid"];

export const signInput = z.object({
  commandRef: z.string().min(8).max(200),
  kind: z.enum(KINDS),
  payload: z.record(z.string(), z.unknown()),
});
export type SignInput = z.infer<typeof signInput>;

export type SignResult =
  | { status: "denied"; requestId?: string; reason: string }
  | { status: "pending_approval"; requestId: string; approvalsNeeded: number }
  | { status: "signed"; requestId: string; raw: Hex; hash: Hex; nonce: bigint; from: Hex }
  | { status: "broadcast"; requestId: string; hash: Hex; nonce: bigint; from: Hex };

interface RequestRow {
  id: string;
  kind: string;
  key_ref: string;
  payload: Record<string, unknown>;
  payload_hash: Buffer;
  policy_id: string | null;
  status: string;
  approvals_needed: number;
  reason: string | null;
  tx_hash: Hex | null;
  nonce: string | null;
  expires_at: Date;
}

const LOCK_KIND = 586_586_070;

/**
 * The reconciliation payout gate (ADR 0007) for a kind: null when the kind is not a payout or
 * payouts are allowed, otherwise the reason for the denial. If the gate cannot be read the query
 * fails and so does the request: nothing is signed (fail closed).
 */
export async function payoutGateDenial(c: pg.ClientBase, kind: string): Promise<string | null> {
  if (!isPayoutKind(kind)) return null;
  const { rows } = await c.query<{ allowed: boolean; reason: string }>("SELECT allowed, reason FROM recon.payout_gate()");
  const gate = rows[0];
  return gate?.allowed === true ? null : `payouts are not allowed by reconciliation: ${gate?.reason ?? "gate unavailable"}`;
}

function payloadHash(kind: string, payload: unknown): Buffer {
  return createHash("sha256").update(JSON.stringify([kind, payload])).digest();
}

export class SignerService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly keys: KeyProvider,
    private readonly chain: ChainReader,
  ) {}

  /** Asks for a signature. Idempotent per commandRef. */
  async request(input: SignInput, requestedBy: string): Promise<SignResult> {
    const parsed = signInput.parse(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // One decision at a time per kind, so daily limits cannot be raced.
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [LOCK_KIND, parsed.kind]);
      const out = await this.decide(client, parsed, requestedBy);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  private async audit(c: pg.ClientBase, actor: string, action: string, requestId: string | null, detail: object): Promise<void> {
    await c.query("SELECT signer.audit_append($1, $2, $3, $4::jsonb)", [actor, action, requestId, JSON.stringify(detail)]);
  }

  private async activePolicy(c: pg.ClientBase, kind: string): Promise<{ id: string; rule: AnyRule } | null> {
    const { rows } = await c.query<{ id: string; rule: unknown }>(
      "SELECT id, rule FROM signer.policies WHERE kind = $1 AND approved_at IS NOT NULL AND retired_at IS NULL",
      [kind],
    );
    const r = rows[0];
    return r ? { id: r.id, rule: parseRule(kind, r.rule) } : null;
  }

  /** Facts are read fresh for every decision, per kind; the evaluation itself is a pure function. */
  private async evaluate(c: pg.ClientBase, kind: string, rule: AnyRule, payload: unknown, excludeRequest: string | null): Promise<Decision> {
    switch (kind) {
      case "issuance.mint":
        return this.evaluateMint(c, rule as MintRule, payload, excludeRequest);
      case "compliance.freeze":
        return this.evaluateFreeze(c, rule as FreezeRule, payload, excludeRequest);
      case "rent.record_payout":
        return this.evaluateRecordPayout(c, rule as RecordPayoutRule, payload);
      case "token.transfer":
        return this.evaluateTransfer(c, rule as TransferRule, payload, excludeRequest);
      case "identity.create":
      case "identity.add_claim":
      case "identity.register":
        return this.evaluateOnboarding(c, kind, rule, payload, excludeRequest);
      default:
        return { decision: "deny", reason: `no evaluator for ${kind}` };
    }
  }

  /** Requests of a kind signed (or about to be) since midnight Pakistan time, all keys; excludes one request. */
  private async signedToday(c: pg.ClientBase, kind: string, excludeRequest: string | null, sumAmounts: boolean): Promise<bigint> {
    const { rows } = await c.query<{ n: string }>(
      `SELECT ${sumAmounts ? "coalesce(sum(amount), 0)" : "count(*)"} AS n FROM signer.requests
       WHERE kind = $1 AND status IN ('approved', 'signed', 'broadcast')
         AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Karachi') AT TIME ZONE 'Asia/Karachi')
         AND ($2::uuid IS NULL OR id <> $2::uuid)`,
      [kind, excludeRequest],
    );
    return BigInt(rows[0]?.n ?? "0");
  }

  private async isCustodial(c: pg.ClientBase, wallet: string): Promise<boolean> {
    const { rowCount } = await c.query("SELECT 1 FROM signer.custodial_wallets WHERE address = $1", [wallet.toLowerCase()]);
    return rowCount === 1 && this.keys.refs().includes(custodialRef(wallet));
  }

  private async evaluateTransfer(c: pg.ClientBase, rule: TransferRule, payload: unknown, excludeRequest: string | null): Promise<Decision> {
    const p = transferPayload.safeParse(payload);
    const closed = { chainId: 0, fromCustodial: false, recipientVerified: false, paused: true, senderFrozen: true, freeBalance: 0n, escrowHeld: 0n, signedToday: 0n };
    if (!p.success) return evaluateTransfer(rule, payload, closed);
    const from = p.data.from.toLowerCase() as Hex;
    const to = p.data.to.toLowerCase() as Hex;
    // Chain reads run in parallel with the database reads; one client runs one query at a time.
    const db = async () => {
      const custodial = await this.isCustodial(c, from);
      const escrow = await c.query<{ n: string }>("SELECT ledger.escrow_held($1) AS n", [p.data.escrowAccount]);
      const used = await this.signedToday(c, "token.transfer", excludeRequest, true);
      return { custodial, escrowHeld: BigInt(escrow.rows[0]?.n ?? "0"), used };
    };
    const [chainId, chainFacts, facts] = await Promise.all([this.chain.chainId(), need(this.chain.transferFacts, "transfer facts")(rule, from, to), db()]);
    return evaluateTransfer(rule, payload, { chainId, ...chainFacts, fromCustodial: facts.custodial, escrowHeld: facts.escrowHeld, signedToday: facts.used });
  }

  private async evaluateOnboarding(c: pg.ClientBase, kind: string, rule: AnyRule, payload: unknown, excludeRequest: string | null): Promise<Decision> {
    const closed: OnboardingFacts = { chainId: 0, custodial: false, kycVerified: false, onChainIdentity: "0x0000000000000000000000000000000000000000", signedToday: 0 };
    const parsed = kind === "identity.create" ? identityCreatePayload.safeParse(payload) : kind === "identity.add_claim" ? identityClaimPayload.safeParse(payload) : identityRegisterPayload.safeParse(payload);
    const idFactory = (rule as IdentityCreateRule | IdentityClaimRule | IdentityRegisterRule).idFactory as Hex;
    let facts = closed;
    if (parsed.success) {
      const wallet = parsed.data.wallet.toLowerCase() as Hex;
      const db = async () => {
        const custodial = await this.isCustodial(c, wallet);
        const kyc = await c.query<{ ok: boolean }>("SELECT kyc.is_verified($1) AS ok", [wallet]);
        const used = await this.signedToday(c, kind, excludeRequest, false);
        return { custodial, kycVerified: kyc.rows[0]?.ok === true, signedToday: Number(used) };
      };
      const [chainId, identity, dbFacts] = await Promise.all([this.chain.chainId(), need(this.chain.identityOf, "identities")(idFactory, wallet), db()]);
      facts = { chainId, onChainIdentity: identity, ...dbFacts };
    }
    if (kind === "identity.create") return evaluateIdentityCreate(rule as IdentityCreateRule, payload, facts);
    if (kind === "identity.add_claim") {
      const r = rule as IdentityClaimRule;
      const p = identityClaimPayload.safeParse(payload);
      // The claim key signs only for a verified owner's own identity; otherwise nothing is signed.
      let claimSignature: Hex | null = null;
      if (p.success && facts.kycVerified && facts.custodial && facts.onChainIdentity === p.data.identity.toLowerCase() && r.topics.includes(p.data.topic)) {
        claimSignature = await this.keys.signMessage(r.claimKeyRef, claimHash(p.data.identity.toLowerCase(), p.data.topic));
      }
      return evaluateIdentityClaim(r, payload, { ...facts, claimSignature });
    }
    const r = rule as IdentityRegisterRule;
    const p = identityRegisterPayload.safeParse(payload);
    let alreadyRegistered = true;
    let topicsWithClaim: number[] = [];
    if (p.success && facts.onChainIdentity === p.data.identity.toLowerCase()) {
      const identity = p.data.identity.toLowerCase() as Hex;
      const [registered, issuers] = await Promise.all([
        need(this.chain.isRegistered, "the identity registry")(r.identityRegistry as Hex, p.data.wallet.toLowerCase() as Hex),
        Promise.all(r.topics.map((t) => need(this.chain.claimIssuerOf, "claims")(identity, claimId(r.claimIssuer.toLowerCase(), t)))),
      ]);
      alreadyRegistered = registered;
      topicsWithClaim = r.topics.filter((_t, i) => issuers.at(i) === r.claimIssuer.toLowerCase());
    }
    return evaluateIdentityRegister(r, payload, { ...facts, alreadyRegistered, topicsWithClaim });
  }

  private async evaluateFreeze(c: pg.ClientBase, rule: FreezeRule, payload: unknown, excludeRequest: string | null): Promise<Decision> {
    const p = freezePayload.safeParse(payload);
    if (!p.success) return evaluateFreeze(rule, payload, { chainId: 0, alreadyFrozen: true, ownerVerified: true, signedToday: 0 });
    const account = p.data.account.toLowerCase() as Hex;
    const [chainId, alreadyFrozen, verified, used] = await Promise.all([
      this.chain.chainId(),
      this.chain.isFrozen(rule, account),
      c.query<{ ok: boolean }>("SELECT kyc.is_verified($1) AS ok", [account]),
      c.query<{ n: string }>(
        `SELECT count(*) AS n FROM signer.requests
         WHERE key_ref = $1 AND kind = 'compliance.freeze' AND status IN ('approved', 'signed', 'broadcast')
           AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Karachi') AT TIME ZONE 'Asia/Karachi')
           AND ($2::uuid IS NULL OR id <> $2::uuid)`,
        [rule.keyRef, excludeRequest],
      ),
    ]);
    return evaluateFreeze(rule, payload, { chainId, alreadyFrozen, ownerVerified: verified.rows[0]?.ok === true, signedToday: Number(used.rows[0]?.n ?? "0") });
  }

  private async evaluateRecordPayout(c: pg.ClientBase, rule: RecordPayoutRule, payload: unknown): Promise<Decision> {
    const p = recordPayoutPayload.safeParse(payload);
    if (!p.success) return evaluateRecordPayout(rule, payload, { chainId: 0, status: "none", token: "", bankFileSha256: null });
    const id = BigInt(p.data.distributionId);
    const [chainId, d, file] = await Promise.all([
      this.chain.chainId(),
      this.chain.distribution(rule, id),
      c.query<{ sha: string | null }>("SELECT bank.distribution_file_hash($1, $2) AS sha", [rule.token.toLowerCase(), id.toString()]),
    ]);
    return evaluateRecordPayout(rule, payload, { chainId, status: d.status, token: d.token, bankFileSha256: file.rows[0]?.sha ?? null });
  }

  private async evaluateMint(c: pg.ClientBase, rule: MintRule, payload: unknown, excludeRequest: string | null): Promise<Decision> {
    const p = mintPayload.safeParse(payload);
    if (!p.success) return evaluateMint(rule, payload, { chainId: 0, recipientVerified: false, supply: 0n, cap: 0n, paused: true, signedToday: 0n });
    const [chainId, facts, used] = await Promise.all([
      this.chain.chainId(),
      this.chain.mintFacts(rule, p.data.to as Hex),
      c.query<{ n: string }>(
        `SELECT coalesce(sum(amount), 0) AS n FROM signer.requests
         WHERE key_ref = $1 AND kind = 'issuance.mint' AND status IN ('approved', 'signed', 'broadcast')
           AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Karachi') AT TIME ZONE 'Asia/Karachi')
           AND ($2::uuid IS NULL OR id <> $2::uuid)`,
        [rule.keyRef, excludeRequest],
      ),
    ]);
    return evaluateMint(rule, payload, { chainId, ...facts, signedToday: BigInt(used.rows[0]?.n ?? "0") });
  }

  private async decide(c: pg.ClientBase, input: SignInput, requestedBy: string): Promise<SignResult> {
    const hash = payloadHash(input.kind, input.payload);
    const { rows } = await c.query<RequestRow>("SELECT * FROM signer.requests WHERE command_ref = $1 FOR UPDATE", [input.commandRef]);
    let req = rows[0];

    if (req) {
      if (!req.payload_hash.equals(hash)) {
        await this.audit(c, requestedBy, "request.conflict", req.id, { commandRef: input.commandRef });
        return { status: "denied", requestId: req.id, reason: "commandRef was already used for a different payload" };
      }
      switch (req.status) {
        case "denied":
        case "rejected":
        case "expired":
          return { status: "denied", requestId: req.id, reason: req.reason ?? req.status };
        case "pending_approval":
          if (req.expires_at < new Date()) {
            await c.query("UPDATE signer.requests SET status = 'expired', reason = 'approval window closed' WHERE id = $1", [req.id]);
            await this.audit(c, "signer", "request.expired", req.id, {});
            return { status: "denied", requestId: req.id, reason: "approval window closed" };
          }
          return { status: "pending_approval", requestId: req.id, approvalsNeeded: req.approvals_needed };
        case "broadcast": {
          if (!req.tx_hash || req.nonce === null) throw new Error("broadcast request without a transaction");
          const from = this.keys.address(req.key_ref);
          // Proven dropped on chain (no receipt, nonce taken by another transaction): it can never
          // be mined, so the command may be signed again with a fresh nonce.
          if ((await this.chain.txState(req.tx_hash, from, BigInt(req.nonce))) === "dropped") {
            await c.query("UPDATE signer.requests SET status = 'released' WHERE id = $1", [req.id]);
            await this.audit(c, "signer", "request.dropped", req.id, { hash: req.tx_hash, nonce: req.nonce });
            return this.sign(c, { ...req, status: "released" }, requestedBy);
          }
          return { status: "broadcast", requestId: req.id, hash: req.tx_hash, nonce: BigInt(req.nonce), from };
        }
        default:
          return this.sign(c, req, requestedBy);
      }
    }

    const frozen = await payoutGateDenial(c, input.kind);
    if (frozen) {
      await this.audit(c, requestedBy, "request.denied", null, { commandRef: input.commandRef, kind: input.kind, reason: frozen });
      return { status: "denied", reason: frozen };
    }
    const policy = await this.activePolicy(c, input.kind);
    const decision: Decision = policy
      ? await this.evaluate(c, input.kind, policy.rule, input.payload, null)
      : { decision: "deny", reason: `no active policy for ${input.kind}` };
    const keyRef = decision.decision === "allow" ? decision.keyRef : policy ? requestKeyRef(input.kind, policy.rule, input.payload) : null;
    if (keyRef === null || !this.keys.refs().includes(keyRef)) {
      await this.audit(c, requestedBy, "request.denied", null, { commandRef: input.commandRef, reason: decision.decision === "deny" ? decision.reason : "signing key not loaded" });
      return { status: "denied", reason: decision.decision === "deny" ? decision.reason : "signing key not loaded" };
    }
    const status = decision.decision === "deny" ? "denied" : decision.approvalsNeeded > 0 ? "pending_approval" : "approved";
    const ins = await c.query<RequestRow>(
      `INSERT INTO signer.requests (command_ref, kind, key_ref, payload, payload_hash, policy_id, amount, requested_by, status, approvals_needed, reason)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [
        input.commandRef,
        input.kind,
        keyRef,
        JSON.stringify(input.payload),
        hash,
        policy?.id ?? null,
        decision.decision === "allow" ? (decision.amount?.toString() ?? null) : null,
        requestedBy,
        status,
        decision.decision === "allow" ? decision.approvalsNeeded : 0,
        decision.decision === "deny" ? decision.reason.slice(0, 500) : null,
      ],
    );
    req = ins.rows[0];
    if (!req) throw new Error("request insert failed");
    await this.audit(c, requestedBy, `request.${status}`, req.id, {
      commandRef: input.commandRef,
      kind: input.kind,
      policy: policy?.id ?? null,
      ...(decision.decision === "deny" ? { reason: decision.reason } : { amount: decision.amount?.toString() ?? null, approvalsNeeded: decision.approvalsNeeded }),
    });
    if (decision.decision === "deny") return { status: "denied", requestId: req.id, reason: decision.reason };
    if (status === "pending_approval") return { status: "pending_approval", requestId: req.id, approvalsNeeded: decision.approvalsNeeded };
    return this.sign(c, req, requestedBy, decision);
  }

  /**
   * Signs an approved (or previously signed / released) request with a reserved nonce. `fresh` is
   * the decision just made for a new request; otherwise facts are read again, because they can
   * change between approval and signing (the approval itself stays).
   */
  private async sign(c: pg.ClientBase, req: RequestRow, requestedBy: string, fresh?: Decision): Promise<SignResult> {
    // Re-checked at signing time: payouts may have been frozen after the request was approved.
    const frozen = await payoutGateDenial(c, req.kind);
    if (frozen) {
      await this.audit(c, requestedBy, "request.denied_at_sign", req.id, { reason: frozen });
      return { status: "denied", requestId: req.id, reason: frozen };
    }
    const policy = await this.activePolicy(c, req.kind);
    if (!policy) return { status: "denied", requestId: req.id, reason: `no active policy for ${req.kind}` };
    const decision = fresh ?? (await this.evaluate(c, req.kind, policy.rule, req.payload, req.id));
    if (decision.decision === "deny") {
      await this.audit(c, requestedBy, "request.denied_at_sign", req.id, { reason: decision.reason });
      return { status: "denied", requestId: req.id, reason: decision.reason };
    }
    const from = this.keys.address(req.key_ref);
    // Simulation and the node's pending nonce are independent: read both at once.
    const [simulated, chainNext] = await Promise.all([
      this.chain.simulate(from, decision.to, decision.data).then(
        () => null,
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      ),
      this.chain.pendingNonce(from),
    ]);
    if (simulated !== null) {
      const reason = `simulation reverted: ${simulated.split("\n")[0] ?? ""}`.slice(0, 400);
      await this.audit(c, requestedBy, "request.denied_at_sign", req.id, { reason });
      return { status: "denied", requestId: req.id, reason };
    }

    // A request that was signed before (e.g. the caller crashed) keeps its nonce while it is
    // still reserved for it, so re-signing yields the identical transaction.
    let nonce: bigint | null = null;
    if (req.status === "signed" && req.nonce !== null) {
      const held = await c.query("SELECT 1 FROM signer.nonces WHERE address = $1 AND nonce = $2 AND request_id = $3 AND status = 'reserved'", [
        from,
        req.nonce,
        req.id,
      ]);
      if (held.rowCount === 1) nonce = BigInt(req.nonce);
      else await c.query("UPDATE signer.requests SET status = 'released' WHERE id = $1", [req.id]);
    }
    if (nonce === null) {
      const { rows } = await c.query<{ n: string }>("SELECT signer.reserve_nonce($1, $2, $3) AS n", [from, chainNext.toString(), req.id]);
      nonce = BigInt(rows[0]?.n ?? "0");
    }
    const chainId = policy.rule.chainId;
    const raw = await this.keys.signTransaction(req.key_ref, {
      type: "legacy",
      chainId,
      nonce: Number(nonce),
      to: decision.to,
      data: decision.data,
      gas: decision.gas,
      gasPrice: 0n,
    });
    const txHash = keccak256(raw);
    await c.query("UPDATE signer.requests SET status = 'signed', nonce = $2, tx_hash = $3 WHERE id = $1", [req.id, nonce.toString(), txHash]);
    await this.audit(c, requestedBy, "request.signed", req.id, { hash: txHash, nonce: nonce.toString(), from });
    return { status: "signed", requestId: req.id, raw, hash: txHash, nonce, from };
  }

  /**
   * Creates a custodial investor wallet (ADR 0010): the key is generated inside the key provider and
   * recorded with its address in signer.custodial_wallets (W-1). Only the address is returned.
   */
  async createWallet(createdBy: string): Promise<{ address: string }> {
    const custody = this.keys as Partial<CustodyProvider>;
    if (typeof custody.createCustodialKey !== "function") throw new Error("this key provider cannot create custodial wallets");
    const { address } = await custody.createCustodialKey();
    await this.pool.query("SELECT signer.register_custodial_wallet($1, 'generated', $2)", [address, createdBy]);
    return { address };
  }

  /** The caller recorded and broadcast the transaction. */
  async markBroadcast(requestId: string, actor: string): Promise<boolean> {
    return this.settle(requestId, actor, "broadcast");
  }

  /** The caller could not record it, so it was never broadcast: free the nonce for reuse. */
  async release(requestId: string, actor: string): Promise<boolean> {
    return this.settle(requestId, actor, "released");
  }

  private async settle(requestId: string, actor: string, to: "broadcast" | "released"): Promise<boolean> {
    if (!z.uuid().safeParse(requestId).success) return false;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<RequestRow>(
        `UPDATE signer.requests SET status = $2 WHERE id = $1 AND status = 'signed' RETURNING *`,
        [requestId, to],
      );
      const req = rows[0];
      if (!req || req.nonce === null) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query("SELECT signer.settle_nonce($1, $2, $3)", [this.keys.address(req.key_ref), req.nonce, to]);
      await this.audit(client, actor, `request.${to}`, req.id, { hash: req.tx_hash, nonce: req.nonce });
      await client.query("COMMIT");
      return true;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
}
