import { randomBytes } from "node:crypto";
import { RefusedError, TransientError, type Command, type Executor, type Hex, type Outcome, type Signed } from "../src/index.ts";

/**
 * In-memory chain for worker tests, with injectable faults per submission attempt:
 *  ok                  sign, record, broadcast, mined successfully
 *  refuse              refused before anything is sent (permanent)
 *  transient           error before anything is sent (retry)
 *  crashBeforeRecord   untyped error before recording (nothing sent)
 *  crashAfterRecord    recorded, then the process "dies" before broadcasting
 *  crashAfterBroadcast broadcast and mined, then the process dies before learning it
 *  revert              broadcast and mined, but reverted
 *  stuck               broadcast, never mined
 */
export type Fault = "ok" | "refuse" | "transient" | "crashBeforeRecord" | "crashAfterRecord" | "crashAfterBroadcast" | "revert" | "stuck";

interface Tx {
  command: bigint;
  nonce: bigint;
  from: Hex;
  state: "pool" | "success" | "reverted";
}

export class FakeChain {
  readonly from: Hex = `0x${"11".repeat(20)}`;
  private readonly txs = new Map<Hex, Tx>();
  private mined = 0n; // next nonce to be mined for `from`
  private readonly plans = new Map<string, Fault[]>();

  plan(idempotencyKey: string, faults: Fault[]): void {
    this.plans.set(idempotencyKey, [...faults]);
  }

  /** Successful transactions per command: the property under test is that this is never above 1. */
  successes(command: bigint): number {
    return [...this.txs.values()].filter((t) => t.command === command && t.state === "success").length;
  }

  /** Mines one "pool" transaction whose nonce is next (used to simulate a slow chain catching up). */
  mineStuck(): void {
    for (const t of this.txs.values()) if (t.state === "pool" && t.nonce === this.mined) this.mine(t, "success");
  }

  private mine(t: Tx, state: "success" | "reverted"): void {
    t.state = state;
    this.mined = t.nonce + 1n;
  }

  private pendingNonce(): bigint {
    let n = this.mined;
    for (const t of this.txs.values()) if (t.state === "pool" && t.nonce >= n) n = t.nonce + 1n;
    return n;
  }

  executor(): Executor {
    return {
      submit: async (cmd: Command, record: (s: Signed) => Promise<boolean>) => {
        const fault = this.plans.get(cmd.idempotencyKey)?.shift() ?? "ok";
        if (fault === "refuse") throw new RefusedError("would revert");
        if (fault === "transient") throw new TransientError("node unreachable");
        if (fault === "crashBeforeRecord") throw new Error("process died before recording");
        const signed: Signed = { hash: `0x${randomBytes(32).toString("hex")}`, nonce: this.pendingNonce(), from: this.from };
        if (!(await record(signed))) return null;
        if (fault === "crashAfterRecord") throw new Error("process died after recording");
        const tx: Tx = { command: cmd.id, nonce: signed.nonce, from: this.from, state: "pool" };
        this.txs.set(signed.hash, tx);
        // A transaction only mines in nonce order; an earlier recorded-but-never-sent nonce blocks it,
        // exactly like a real node. Here the chain simply skips such gaps by mining at this nonce.
        if (fault === "ok" || fault === "crashAfterBroadcast") this.mine(tx, "success");
        if (fault === "revert") this.mine(tx, "reverted");
        if (fault === "crashAfterBroadcast") throw new Error("process died after broadcasting");
        return signed;
      },
      wait: async (s: Signed) => {
        await Promise.resolve();
        const t = this.txs.get(s.hash);
        return t?.state === "success" ? "success" : t?.state === "reverted" ? "reverted" : "pending";
      },
      outcome: async (s: Signed): Promise<Outcome> => {
        await Promise.resolve();
        const t = this.txs.get(s.hash);
        if (t?.state === "success") return "success";
        if (t?.state === "reverted") return "reverted";
        if (this.mined > s.nonce) return "dropped";
        return t ? "pending" : "unknown";
      },
    };
  }
}
