import { createHash } from "node:crypto";
import type pg from "pg";
import { createPublicClient, http, keccak256, type Hex } from "viem";
import { identityRegistryAbi, issuanceGuardAbi, tokenAbi } from "@pt/contracts";
import { z } from "zod";
import type { KeyProvider } from "./keystore.ts";
import { evaluateMint, isPayoutKind, KINDS, mintPayload, parseRule, type Decision, type MintRule } from "./policy.ts";

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
  /** "dropped" only when there is no receipt and the sender's mined nonce is past this one. */
  txState(hash: Hex, from: Hex, nonce: bigint): Promise<"mined" | "dropped" | "pending">;
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
  };
}

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

  private async activePolicy(c: pg.ClientBase, kind: string): Promise<{ id: string; rule: MintRule } | null> {
    const { rows } = await c.query<{ id: string; rule: unknown }>(
      "SELECT id, rule FROM signer.policies WHERE kind = $1 AND approved_at IS NOT NULL AND retired_at IS NULL",
      [kind],
    );
    const r = rows[0];
    return r ? { id: r.id, rule: parseRule(kind, r.rule) } : null;
  }

  private async evaluate(c: pg.ClientBase, rule: MintRule, payload: unknown, excludeRequest: string | null): Promise<Decision> {
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
      ? await this.evaluate(c, policy.rule, input.payload, null)
      : { decision: "deny", reason: `no active policy for ${input.kind}` };
    const keyRef = decision.decision === "allow" ? decision.keyRef : (policy?.rule.keyRef ?? null);
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
        decision.decision === "allow" ? decision.amount.toString() : null,
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
      ...(decision.decision === "deny" ? { reason: decision.reason } : { amount: decision.amount.toString(), approvalsNeeded: decision.approvalsNeeded }),
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
    const decision = fresh ?? (await this.evaluate(c, policy.rule, req.payload, req.id));
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
