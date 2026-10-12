import { DeferredError, RefusedError, TransientError, type Command, type Executor, type Outcome, type Signed } from "@pt/outbox";
import { createPublicClient, http, type Hex } from "viem";
import type { SignerClient } from "./http.ts";
import { KINDS, type Kind } from "./policy.ts";

/**
 * Outbox executor backed by the signing service. The signer decides and signs; this executor keeps
 * the outbox rule "record before broadcast" (O-5):
 *   signed -> record(hash, nonce, sender) -> broadcast -> tell the signer (broadcast)
 *   record refused (lease lost) -> tell the signer (release): the nonce is reused, nothing was sent
 *   pending approval -> DeferredError (no attempt used); denied -> RefusedError (nothing sent)
 */
export function signerExecutor(signer: SignerClient, opts: { rpcUrl: string; approvalPollSeconds?: number }): Executor {
  const chain = createPublicClient({ transport: http(opts.rpcUrl, { timeout: 10_000 }), pollingInterval: 250 });

  return {
    async submit(cmd: Command, record: (s: Signed) => Promise<boolean>) {
      if (!(KINDS as readonly string[]).includes(cmd.kind)) throw new RefusedError(`kind ${cmd.kind} has no signing policy`);
      let res;
      try {
        res = await signer.sign({ commandRef: cmd.idempotencyKey, kind: cmd.kind as Kind, payload: cmd.payload });
      } catch (e) {
        throw new TransientError(`signer unavailable: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (res.status === "denied") throw new RefusedError(`signer denied: ${res.reason}`);
      if (res.status === "pending_approval") {
        throw new DeferredError(`awaiting ${String(res.approvalsNeeded)} approvals (request ${res.requestId})`, opts.approvalPollSeconds ?? 60);
      }
      if (res.status === "broadcast") {
        // Already sent under this command earlier; the outbox resolves it from the chain.
        throw new TransientError(`already broadcast as ${res.hash}`);
      }
      const signed: Signed = { hash: res.hash, nonce: res.nonce, from: res.from.toLowerCase() as Hex };
      if (!(await record(signed))) {
        await signer.release(res.requestId).catch(() => undefined);
        return null;
      }
      await chain.sendRawTransaction({ serializedTransaction: res.raw });
      await signer.broadcast(res.requestId).catch(() => undefined); // best effort: stale entries are reconciled
      return signed;
    },

    async wait(s, timeoutMs) {
      try {
        const r = await chain.waitForTransactionReceipt({ hash: s.hash, timeout: timeoutMs });
        return r.status === "success" ? "success" : "reverted";
      } catch {
        return "pending";
      }
    },

    async outcome(s): Promise<Outcome> {
      try {
        const receipt = await chain.getTransactionReceipt({ hash: s.hash }).catch(() => null);
        if (receipt) return receipt.status === "success" ? "success" : "reverted";
        const mined = await chain.getTransactionCount({ address: s.from, blockTag: "latest" });
        if (BigInt(mined) > s.nonce) return "dropped";
        const inPool = await chain.getTransaction({ hash: s.hash }).catch(() => null);
        return inPool ? "pending" : "unknown";
      } catch {
        return "unknown";
      }
    },
  };
}
