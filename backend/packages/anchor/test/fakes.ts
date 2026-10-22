import { randomBytes } from "node:crypto";
import { stateAnchorAbi } from "@pt/contracts";
import type { KeyProvider } from "@pt/signer";
import { decodeFunctionData, keccak256, parseTransaction, recoverTransactionAddress, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AnchorChain, AnchoredEvent, BesuSource, Receipt, Simulation } from "../src/chains.ts";
import { ZERO_HASH } from "../src/commitment.ts";
import { LOCAL_ANCHOR_CHAIN_ID } from "../src/network.ts";

export const randomAddress = (): Address => `0x${randomBytes(20).toString("hex")}`;

/** An in-memory KeyProvider for tests (a fresh random key). */
export function memoryKeys(ref = "anchor"): KeyProvider {
  const account = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
  return {
    refs: () => [ref],
    address: (r) => {
      if (r !== ref) throw new Error(`unknown key ${r}`);
      return account.address.toLowerCase() as Hex;
    },
    signTransaction: (r, tx) => {
      if (r !== ref) throw new Error(`unknown key ${r}`);
      return account.signTransaction(tx);
    },
    signMessage: (r, hash) => {
      if (r !== ref) throw new Error(`unknown key ${r}`);
      return account.signMessage({ message: { raw: hash } });
    },
  };
}

/** The private chain: block hashes derived from an epoch; `rewrite` simulates colluding validators. */
export class FakeBesu implements BesuSource {
  height = 100n;
  readonly id: number;
  private readonly rewritten = new Map<bigint, Hex>();
  private readonly epoch = randomBytes(8).toString("hex");

  constructor(id = 586_586) {
    this.id = id;
  }

  chainId(): Promise<number> {
    return Promise.resolve(this.id);
  }

  head(): Promise<bigint> {
    return Promise.resolve(this.height);
  }

  blockHash(n: bigint): Promise<Hex> {
    if (n > this.height || n < 0n) return Promise.reject(new Error(`block ${n.toString()} not available`));
    return Promise.resolve(this.rewritten.get(n) ?? keccak256(toBytes(`besu-${this.epoch}-${n.toString()}`)));
  }

  rewrite(n: bigint): void {
    this.rewritten.set(n, keccak256(toBytes(`rewritten-${n.toString()}`)));
  }
}

interface PoolTx {
  hash: Hex;
  raw: Hex;
  from: Address;
  nonce: bigint;
  to: Address | null;
  data: Hex;
}

/**
 * The public anchor chain with StateAnchor semantics (anchor key only, strictly increasing,
 * never overwritten), nonces, a mempool and injectable faults:
 *   failCalls      the next N RPC calls throw (node unreachable)
 *   loseBroadcast  the next sendRaw is "accepted" but never reaches the pool
 *   loseResponse   the next sendRaw reaches the pool (and is mined) but the caller gets an error
 *   automine       mine every accepted transaction at once (Anvil's default) or only on mine()
 */
export class FakeAnchorChain implements AnchorChain {
  readonly id: number;
  readonly contract: Address = randomAddress();
  anchorKey: Address;
  automine = true;
  failCalls = 0;
  loseBroadcast = false;
  loseResponse = false;
  gasPriceWei = 1_000_000_000n;
  /** null = a pre-London chain (no base fee): the anchorer falls back to gasPrice. */
  baseFeeWei: bigint | null = 100_000_000n;
  priorityFeeWei = 1_000_000_000n;
  codeless = false;
  reverted = 0;
  readonly anchors = new Map<bigint, Hex>();
  last = 0n;
  readonly events: AnchoredEvent[] = [];
  private readonly blocks: Hex[] = [keccak256(toBytes(`anchor-genesis-${randomBytes(4).toString("hex")}`))];
  private readonly nonces = new Map<Address, bigint>();
  private pool: PoolTx[] = [];
  /** Every raw transaction handed to sendRaw, in order (tests read the price that was signed). */
  readonly sentRaw: Hex[] = [];
  private readonly receipts = new Map<Hex, Receipt>();
  readonly successesBy = new Map<Address, number>();

  constructor(anchorKey: Address, id = LOCAL_ANCHOR_CHAIN_ID) {
    this.anchorKey = anchorKey.toLowerCase() as Address;
    this.id = id;
  }

  private rpc(): void {
    if (this.failCalls > 0) {
      this.failCalls--;
      throw new Error("anchor RPC unreachable (injected)");
    }
  }

  private async call<T>(fn: () => T): Promise<T> {
    await Promise.resolve();
    this.rpc();
    return fn();
  }

  chainId = (): Promise<number> => this.call(() => this.id);
  head = (): Promise<bigint> => this.call(() => BigInt(this.blocks.length - 1));
  blockHash = (n: bigint): Promise<Hex | null> => this.call(() => this.blocks[Number(n)] ?? null);
  hasCode = (a: Address): Promise<boolean> => this.call(() => !this.codeless && a.toLowerCase() === this.contract);
  anchorer = (): Promise<Address> => this.call(() => this.anchorKey);
  lastAnchoredBlock = (): Promise<bigint> => this.call(() => this.last);
  anchorOf = (_c: Address, b: bigint): Promise<Hex> => this.call(() => this.anchors.get(b) ?? ZERO_HASH);
  gasPrice = (): Promise<bigint> => this.call(() => this.gasPriceWei);
  fees = (): Promise<{ baseFee: bigint | null; priorityFee: bigint }> => this.call(() => ({ baseFee: this.baseFeeWei, priorityFee: this.priorityFeeWei }));
  receipt = (h: Hex): Promise<Receipt | null> => this.call(() => this.receipts.get(h.toLowerCase() as Hex) ?? null);
  inPool = (h: Hex): Promise<boolean> => this.call(() => this.pool.some((t) => t.hash === h.toLowerCase()));

  nonce = (a: Address, tag: "latest" | "pending"): Promise<bigint> =>
    this.call(() => {
      const from = a.toLowerCase() as Address;
      let n = this.nonces.get(from) ?? 0n;
      if (tag === "pending") for (const t of this.pool) if (t.from === from && t.nonce >= n) n = t.nonce + 1n;
      return n;
    });

  private refusal(from: Address, besuBlock: bigint, value: Hex): string | null {
    if (from.toLowerCase() !== this.anchorKey) return "Unauthorized";
    if (besuBlock <= this.last) return "NotIncreasing";
    if (value === ZERO_HASH) return "ZeroHash";
    return null;
  }

  simulateAnchor = (_c: Address, from: Address, besuBlock: bigint, value: Hex): Promise<Simulation> =>
    this.call(() => {
      const reason = this.refusal(from, besuBlock, value);
      return reason ? { ok: false as const, reason } : { ok: true as const };
    });

  lastRaw(): Hex {
    const raw = this.sentRaw.at(-1);
    if (!raw) throw new Error("nothing was sent");
    return raw;
  }

  async sendRaw(raw: Hex): Promise<void> {
    this.sentRaw.push(raw);
    this.rpc();
    const tx = parseTransaction(raw);
    if (tx.chainId !== this.id) throw new Error("wrong chain ID");
    const from = (await recoverTransactionAddress({ serializedTransaction: raw as Parameters<typeof recoverTransactionAddress>[0]["serializedTransaction"] })).toLowerCase() as Address;
    const hash = keccak256(raw);
    if (this.receipts.has(hash) || this.pool.some((t) => t.hash === hash)) throw new Error("already known");
    const nonce = BigInt(tx.nonce ?? 0);
    if (nonce < (this.nonces.get(from) ?? 0n)) throw new Error("nonce too low");
    if (this.loseBroadcast) {
      this.loseBroadcast = false;
      return;
    }
    this.pool.push({ hash, raw, from, nonce, to: (tx.to?.toLowerCase() ?? null) as Address | null, data: tx.data ?? "0x" });
    if (this.automine) this.mine();
    if (this.loseResponse) {
      this.loseResponse = false;
      throw new Error("connection reset after send (injected)");
    }
  }

  /** Mines one block with every executable pool transaction. */
  mine(): void {
    const number = BigInt(this.blocks.length);
    const blockHash = keccak256(toBytes(`anchor-block-${number.toString()}-${this.blocks[0] ?? ""}`));
    this.blocks.push(blockHash);
    let progress = true;
    let logIndex = 0;
    while (progress) {
      progress = false;
      for (const t of [...this.pool].sort((a, b) => (a.nonce < b.nonce ? -1 : 1))) {
        if (t.nonce !== (this.nonces.get(t.from) ?? 0n)) continue;
        this.pool = this.pool.filter((x) => x !== t);
        this.nonces.set(t.from, t.nonce + 1n);
        // Any other pool transaction with the same nonce can never be mined now.
        this.pool = this.pool.filter((x) => !(x.from === t.from && x.nonce === t.nonce));
        let status: Receipt["status"] = "reverted";
        if (t.to === this.contract) {
          const { functionName, args } = decodeFunctionData({ abi: stateAnchorAbi, data: t.data });
          if (functionName === "anchor") {
            const [besuBlock, value] = args;
            if (this.refusal(t.from, besuBlock, value) === null) {
              this.anchors.set(besuBlock, value.toLowerCase() as Hex);
              this.last = besuBlock;
              this.events.push({ besuBlock, commitment: value.toLowerCase() as Hex, txHash: t.hash, blockNumber: number, blockHash, logIndex: logIndex++ });
              status = "success";
              this.successesBy.set(t.from, (this.successesBy.get(t.from) ?? 0) + 1);
            }
          }
        }
        if (status === "reverted") this.reverted++;
        this.receipts.set(t.hash, { status, blockNumber: number, blockHash });
        progress = true;
      }
    }
  }

  /** Another transaction from `from` uses its next nonce (e.g. a manual transfer with the same key). */
  consumeNonce(from: Address): void {
    const a = from.toLowerCase() as Address;
    const n = this.nonces.get(a) ?? 0n;
    this.nonces.set(a, n + 1n);
    this.pool = this.pool.filter((x) => !(x.from === a && x.nonce === n));
    this.blocks.push(keccak256(toBytes(`anchor-block-${String(this.blocks.length)}-other`)));
  }

  /** Someone else writes an anchor (a stolen anchor key). */
  rogueAnchor(besuBlock: bigint, value: Hex): void {
    const number = BigInt(this.blocks.length);
    const blockHash = keccak256(toBytes(`anchor-block-${number.toString()}-rogue`));
    this.blocks.push(blockHash);
    this.anchors.set(besuBlock, value);
    this.last = besuBlock;
    this.events.push({ besuBlock, commitment: value, txHash: keccak256(toBytes(`rogue-${besuBlock.toString()}`)), blockNumber: number, blockHash, logIndex: 0 });
  }

  anchoredEvents = (_c: Address, from: bigint, to: bigint): Promise<AnchoredEvent[]> =>
    this.call(() => this.events.filter((e) => e.blockNumber >= from && e.blockNumber <= to));
}
