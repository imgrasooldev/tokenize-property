import { stateAnchorAbi } from "@pt/contracts";
import type { KeyProvider } from "@pt/signer";
import type pg from "pg";
import { encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import type { AnchorChain, BesuSource } from "./chains.ts";
import { computeCommitment, ZERO_HASH } from "./commitment.ts";
import { ledgerHead } from "./ledger.ts";
import { sendProblem, type KeyCustody } from "./network.ts";
import {
  clearDropped,
  confirmAnchor,
  failAnchor,
  getAnchor,
  lastAnchor,
  markSent,
  openAnchor,
  recordAnchor,
  type AnchorRecord,
  type Target,
} from "./store.ts";

/**
 * Something a human must look at; the job stops (fail closed) instead of guessing. Examples: the
 * contract holds an anchor this database never recorded, the anchor key was rotated, a transaction
 * reverted, the ledger head moved backwards.
 */
export class AnchorAlarm extends Error {
  override name = "AnchorAlarm";
}

/** Points where tests inject a crash (the process "dies" there). */
export type CrashPoint = "recorded" | "signed" | "sent-recorded" | "broadcast";

export interface AnchorerOptions {
  target: Target;
  besuChainId: number;
  keys: KeyProvider;
  keyRef: string;
  custody: KeyCustody;
  production?: boolean;
  /** ANCHOR_ALLOW_CHAIN_ID; required for any chain other than the local stand-in. */
  allowChainId?: number | undefined;
  actor: string;
  /** Private blocks to stay behind the head (QBFT is final immediately: 0). */
  besuConfirmations?: bigint;
  /** Anchor-chain blocks on top of the anchor before it counts as confirmed. */
  confirmations?: bigint;
  gasLimit?: bigint;
  maxGasPriceWei?: bigint;
  /** Highest tip paid above the base fee (the node's suggestion is capped here). */
  maxPriorityFeeWei?: bigint;
  receiptWaitMs?: number;
  pollMs?: number;
  hooks?: { at?: (point: CrashPoint) => void | Promise<void> } | undefined;
}

export type RunResult =
  | { action: "anchored"; id: bigint; besuBlock: bigint; commitment: Hex; txHash: Hex; anchorBlock: bigint; ms: number }
  | { action: "pending"; id: bigint; reason: string; ms: number }
  | { action: "skipped"; reason: string; ms: number }
  | { action: "busy"; ms: number };

/** A result before its duration is added. */
type Step = { [K in RunResult["action"]]: Omit<Extract<RunResult, { action: K }>, "ms"> }[RunResult["action"]];

const LOCK_KEY = 586_586_071;
const ALARM_CODES = new Set(["PTA02", "PTA03", "PTA04"]);

/**
 * The anchoring job (ADR 0008). One `runOnce` either finishes the open anchor or writes a new one:
 *  1. preflight: both chain IDs, the network policy, contract code, and that the contract's anchor key
 *     is the key this process holds;
 *  2. an open anchor is resolved from the CHAIN, never from an error type: mined -> confirmed;
 *     reverted -> failed + alarm; nonce used by another transaction -> proven dropped -> re-signed;
 *     not visible at all -> the SAME signed transaction is broadcast again;
 *  3. otherwise the contract's last anchored block must equal the database's; then the finalized
 *     private block and the ledger head are read, the commitment is computed and RECORDED, the
 *     transaction is signed, RECORDED with its raw bytes, and only then broadcast.
 * A session advisory lock allows one job per contract; the database refuses a second open anchor
 * and any block that is not higher than the last one.
 */
export class Anchorer {
  private readonly o: Required<Omit<AnchorerOptions, "allowChainId" | "hooks">> & Pick<AnchorerOptions, "allowChainId" | "hooks">;

  constructor(
    private readonly pool: pg.Pool,
    private readonly chain: AnchorChain,
    private readonly besu: BesuSource,
    options: AnchorerOptions,
  ) {
    this.o = {
      production: false,
      besuConfirmations: 0n,
      confirmations: 0n,
      gasLimit: 150_000n,
      maxGasPriceWei: 50_000_000_000n,
      maxPriorityFeeWei: 2_000_000_000n,
      receiptWaitMs: 30_000,
      pollMs: 250,
      ...options,
      target: { anchorChainId: options.target.anchorChainId, contract: options.target.contract.toLowerCase() as Address },
    };
  }

  private get from(): Address {
    return this.o.keys.address(this.o.keyRef).toLowerCase() as Address;
  }

  async runOnce(): Promise<RunResult> {
    const t0 = performance.now();
    const ms = (): number => Math.round(performance.now() - t0);
    const client = await this.pool.connect();
    let locked = false;
    let broken = false;
    try {
      const lock = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1, hashtext($2)) AS ok", [
        LOCK_KEY,
        `${String(this.o.target.anchorChainId)}:${this.o.target.contract}`,
      ]);
      locked = lock.rows[0]?.ok === true;
      if (!locked) return { action: "busy", ms: ms() };
      await this.preflight();
      const open = await openAnchor(client, this.o.target);
      if (open) return { ...(await this.resolve(client, open)), ms: ms() };
      return { ...(await this.anchorNew(client)), ms: ms() };
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code && ALARM_CODES.has(code)) throw new AnchorAlarm((e as Error).message, { cause: e });
      throw e;
    } finally {
      if (locked) {
        await client.query("SELECT pg_advisory_unlock($1, hashtext($2))", [LOCK_KEY, `${String(this.o.target.anchorChainId)}:${this.o.target.contract}`]).catch(() => {
          broken = true; // never hand a connection that may still hold the lock back to the pool
        });
      }
      client.release(broken);
    }
  }

  private async preflight(): Promise<void> {
    const { target } = this.o;
    const [anchorChainId, besuChainId] = await Promise.all([this.chain.chainId(), this.besu.chainId()]);
    if (anchorChainId !== target.anchorChainId) throw new Error(`the anchor RPC serves chain ${String(anchorChainId)}, expected ${String(target.anchorChainId)}`);
    if (besuChainId !== this.o.besuChainId) throw new Error(`the private RPC serves chain ${String(besuChainId)}, expected ${String(this.o.besuChainId)}`);
    const problem = sendProblem({
      anchorChainId,
      besuChainId,
      production: this.o.production,
      allowChainId: this.o.allowChainId,
      custody: this.o.custody,
    });
    if (problem) throw new AnchorAlarm(problem);
    if (!(await this.chain.hasCode(target.contract))) throw new AnchorAlarm(`no contract at ${target.contract} on chain ${String(anchorChainId)}`);
    const key = await this.chain.anchorer(target.contract);
    if (key.toLowerCase() !== this.from) throw new AnchorAlarm(`the contract's anchor key is ${key}, this process holds ${this.from} (rotated?)`);
  }

  private async anchorNew(client: pg.PoolClient): Promise<Step> {
    const { target } = this.o;
    const [onChain, last] = await Promise.all([this.chain.lastAnchoredBlock(target.contract), lastAnchor(client, target)]);
    const recorded = last?.besuBlock ?? 0n;
    if (onChain !== recorded) {
      throw new AnchorAlarm(`the contract's last anchored block is ${onChain.toString()}, the database's is ${recorded.toString()}`);
    }
    if (last && (await this.chain.anchorOf(target.contract, last.besuBlock)) !== last.commitment) {
      throw new AnchorAlarm(`the contract's anchor for block ${last.besuBlock.toString()} differs from the recorded commitment`);
    }
    const head = await this.besu.head();
    const besuBlock = head - this.o.besuConfirmations;
    if (besuBlock <= recorded || besuBlock <= 0n) return { action: "skipped", reason: `no new private block since block ${recorded.toString()}` };
    const besuBlockHash = await this.besu.blockHash(besuBlock);
    const ledger = await ledgerHead(client);
    const input = {
      besuChainId: BigInt(this.o.besuChainId),
      besuBlock,
      besuBlockHash,
      ledgerJournalId: ledger.journalId,
      ledgerHeadHash: ledger.hash,
    };
    const commitment = computeCommitment(input);
    const id = await recordAnchor(client, target, { ...input, commitment }, this.o.actor);
    await this.o.hooks?.at?.("recorded");
    return this.send(client, await getAnchor(client, id));
  }

  /** Signs, records and broadcasts a 'recorded' anchor. */
  private async send(client: pg.PoolClient, rec: AnchorRecord): Promise<Step> {
    const { target } = this.o;
    const sim = await this.chain.simulateAnchor(target.contract, this.from, rec.besuBlock, rec.commitment);
    if (!sim.ok) {
      const reason = `the contract refuses block ${rec.besuBlock.toString()}: ${sim.reason}`;
      await failAnchor(client, rec.id, reason, this.o.actor);
      throw new AnchorAlarm(reason);
    }
    const gasPrice = await this.price();
    if (gasPrice > this.o.maxGasPriceWei) {
      return { action: "pending", id: rec.id, reason: `gas price ${gasPrice.toString()} wei is above the cap ${this.o.maxGasPriceWei.toString()}; nothing sent` };
    }
    const nonce = await this.chain.nonce(this.from, "pending");
    const data = encodeFunctionData({ abi: stateAnchorAbi, functionName: "anchor", args: [rec.besuBlock, rec.commitment] });
    const raw = await this.o.keys.signTransaction(this.o.keyRef, {
      type: "legacy",
      chainId: target.anchorChainId,
      nonce: Number(nonce),
      to: target.contract,
      data,
      gas: this.o.gasLimit,
      gasPrice,
    });
    await this.o.hooks?.at?.("signed");
    const tx = { hash: keccak256(raw), nonce, from: this.from, raw };
    if (!(await markSent(client, rec.id, tx, this.o.actor))) {
      return { action: "pending", id: rec.id, reason: "the anchor changed state concurrently; nothing sent" };
    }
    await this.o.hooks?.at?.("sent-recorded");
    await this.broadcast(raw);
    await this.o.hooks?.at?.("broadcast");
    return this.settle(client, { ...rec, status: "sent", tx });
  }

  /**
   * The price of a legacy transaction. On an EIP-1559 chain it is 2 x base fee + a capped tip: the
   * base fee is set by the protocol, so our own transactions cannot raise the next price. (Pricing
   * from eth_gasPrice + 25 % fed back into a node that suggests tips from recent transactions: on a
   * quiet chain each anchor raised the next suggestion until the cap stopped anchoring, 2026-10-13.)
   * Without a base fee (pre-London chain) it falls back to eth_gasPrice + 25 %.
   */
  private async price(): Promise<bigint> {
    const f = await this.chain.fees();
    if (f.baseFee === null) {
      const p = await this.chain.gasPrice();
      return p + p / 4n;
    }
    const tip = f.priorityFee < this.o.maxPriorityFeeWei ? f.priorityFee : this.o.maxPriorityFeeWei;
    return 2n * f.baseFee + tip;
  }

  /** The outcome is decided from the chain afterwards, never from the error of the broadcast itself. */
  private async broadcast(raw: Hex): Promise<void> {
    await this.chain.sendRaw(raw).catch(() => undefined);
  }

  private async settle(client: pg.PoolClient, rec: AnchorRecord): Promise<Step> {
    const hash = rec.tx?.hash;
    if (!hash) throw new Error("settle needs a recorded transaction");
    const deadline = performance.now() + this.o.receiptWaitMs;
    while ((await this.chain.receipt(hash)) === null && performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.o.pollMs));
    }
    return this.resolve(client, rec, false);
  }

  /** Decides an open anchor from the chain. */
  private async resolve(client: pg.PoolClient, rec: AnchorRecord, mayRebroadcast = true): Promise<Step> {
    if (rec.status === "recorded" || !rec.tx) return this.send(client, rec);
    const { target } = this.o;
    const tx = rec.tx;
    const receipt = await this.chain.receipt(tx.hash);
    if (receipt) {
      if (receipt.status === "reverted") {
        const reason = `anchor transaction ${tx.hash} reverted in anchor-chain block ${receipt.blockNumber.toString()}`;
        await failAnchor(client, rec.id, reason, this.o.actor);
        throw new AnchorAlarm(reason);
      }
      const head = await this.chain.head();
      if (head < receipt.blockNumber + this.o.confirmations) {
        return { action: "pending", id: rec.id, reason: `mined in block ${receipt.blockNumber.toString()}; waiting for ${this.o.confirmations.toString()} confirmations` };
      }
      if ((await this.chain.anchorOf(target.contract, rec.besuBlock)) !== rec.commitment) {
        throw new AnchorAlarm(`transaction ${tx.hash} was mined but the contract holds a different value for block ${rec.besuBlock.toString()}`);
      }
      await confirmAnchor(client, rec.id, tx.hash, receipt.blockNumber, receipt.blockHash, this.o.actor);
      return { action: "anchored", id: rec.id, besuBlock: rec.besuBlock, commitment: rec.commitment, txHash: tx.hash, anchorBlock: receipt.blockNumber };
    }
    const mined = await this.chain.nonce(tx.from, "latest");
    if (mined > tx.nonce) {
      // Another transaction used the nonce. Look once more (ours may have been mined in between).
      if (await this.chain.receipt(tx.hash)) return this.resolve(client, rec, mayRebroadcast);
      if ((await this.chain.anchorOf(target.contract, rec.besuBlock)) !== ZERO_HASH) {
        throw new AnchorAlarm(`block ${rec.besuBlock.toString()} was anchored by a transaction this job did not record`);
      }
      await clearDropped(client, rec.id, tx.hash, `nonce ${tx.nonce.toString()} was used by another transaction`, this.o.actor);
      return this.send(client, { ...rec, status: "recorded", tx: null });
    }
    if (await this.chain.inPool(tx.hash)) {
      return mayRebroadcast ? this.settle(client, rec) : { action: "pending", id: rec.id, reason: `transaction ${tx.hash} is waiting in the pool` };
    }
    // Not mined, not in the pool, nonce unused: the broadcast was lost or never happened. Send the
    // SAME signed bytes again; a second signature is never made for an unresolved transaction.
    if (!mayRebroadcast) return { action: "pending", id: rec.id, reason: `transaction ${tx.hash} is not visible yet` };
    await this.broadcast(tx.raw);
    return this.settle(client, rec);
  }
}
