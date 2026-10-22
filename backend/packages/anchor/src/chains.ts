import { stateAnchorAbi } from "@pt/contracts";
import { BaseError, ContractFunctionRevertedError, createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";

/** The private chain (Besu), read-only. */
export interface BesuSource {
  chainId(): Promise<number>;
  head(): Promise<bigint>;
  /** Hash of the block at `number`; throws if the node does not have it. */
  blockHash(number: bigint): Promise<Hex>;
}

export interface Receipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  blockHash: Hex;
}

export interface AnchoredEvent {
  besuBlock: bigint;
  commitment: Hex;
  txHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  logIndex: number;
}

/** Why a call to StateAnchor.anchor would revert, or null if it would succeed. */
export type Simulation = { ok: true } | { ok: false; reason: string };

/** The public anchor chain. The RPC implementation is below; tests use a fake with injected faults. */
export interface AnchorChain {
  chainId(): Promise<number>;
  head(): Promise<bigint>;
  blockHash(number: bigint): Promise<Hex | null>;
  hasCode(address: Address): Promise<boolean>;
  anchorer(contract: Address): Promise<Address>;
  lastAnchoredBlock(contract: Address): Promise<bigint>;
  anchorOf(contract: Address, besuBlock: bigint): Promise<Hex>;
  nonce(address: Address, tag: "latest" | "pending"): Promise<bigint>;
  gasPrice(): Promise<bigint>;
  /** EIP-1559 fee facts: the latest block's base fee (null before London) and the node's tip suggestion. */
  fees(): Promise<{ baseFee: bigint | null; priorityFee: bigint }>;
  simulateAnchor(contract: Address, from: Address, besuBlock: bigint, commitment: Hex): Promise<Simulation>;
  sendRaw(raw: Hex): Promise<void>;
  receipt(hash: Hex): Promise<Receipt | null>;
  inPool(hash: Hex): Promise<boolean>;
  /** Anchored events of `contract` in [from, to]; callers keep the range within the node's log limit. */
  anchoredEvents(contract: Address, from: bigint, to: bigint): Promise<AnchoredEvent[]>;
}

export function rpcBesu(url: string, timeoutMs = 10_000): BesuSource {
  const client = createPublicClient({ transport: http(url, { timeout: timeoutMs, retryCount: 1 }) });
  return {
    chainId: () => client.getChainId(),
    head: () => client.getBlockNumber({ cacheTime: 0 }),
    async blockHash(number) {
      const b = await client.getBlock({ blockNumber: number });
      return b.hash.toLowerCase() as Hex;
    },
  };
}

export function rpcAnchorChain(url: string, timeoutMs = 15_000): AnchorChain & { client: PublicClient } {
  const client = createPublicClient({ transport: http(url, { timeout: timeoutMs, retryCount: 1 }), pollingInterval: 250 });
  return {
    client,
    chainId: () => client.getChainId(),
    head: () => client.getBlockNumber({ cacheTime: 0 }),
    async blockHash(number) {
      const b = await client.getBlock({ blockNumber: number }).catch(() => null);
      return b ? (b.hash.toLowerCase() as Hex) : null;
    },
    async hasCode(address) {
      const code = await client.getCode({ address });
      return code !== undefined && code !== "0x";
    },
    async anchorer(contract) {
      return (await client.readContract({ address: contract, abi: stateAnchorAbi, functionName: "anchorer" })).toLowerCase() as Address;
    },
    lastAnchoredBlock: (contract) => client.readContract({ address: contract, abi: stateAnchorAbi, functionName: "lastAnchoredBlock" }),
    async anchorOf(contract, besuBlock) {
      return (await client.readContract({ address: contract, abi: stateAnchorAbi, functionName: "anchors", args: [besuBlock] })).toLowerCase() as Hex;
    },
    async nonce(address, tag) {
      return BigInt(await client.getTransactionCount({ address, blockTag: tag }));
    },
    gasPrice: () => client.getGasPrice(),
    async fees() {
      const block = await client.getBlock({ blockTag: "latest" });
      const priorityFee = await client.estimateMaxPriorityFeePerGas().catch(() => 0n);
      return { baseFee: block.baseFeePerGas ?? null, priorityFee };
    },
    async simulateAnchor(contract, from, besuBlock, commitment) {
      try {
        await client.simulateContract({ address: contract, abi: stateAnchorAbi, functionName: "anchor", args: [besuBlock, commitment], account: from });
        return { ok: true };
      } catch (e) {
        const revert = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
        if (revert instanceof ContractFunctionRevertedError) return { ok: false, reason: revert.data?.errorName ?? revert.shortMessage };
        throw e; // not a revert: the node failed, nothing is known
      }
    },
    async sendRaw(raw) {
      await client.sendRawTransaction({ serializedTransaction: raw });
    },
    async receipt(hash) {
      const r = await client.getTransactionReceipt({ hash }).catch(() => null);
      return r ? { status: r.status, blockNumber: r.blockNumber, blockHash: r.blockHash.toLowerCase() as Hex } : null;
    },
    async inPool(hash) {
      return (await client.getTransaction({ hash }).catch(() => null)) !== null;
    },
    async anchoredEvents(contract, from, to) {
      const logs = await client.getContractEvents({ address: contract, abi: stateAnchorAbi, eventName: "Anchored", fromBlock: from, toBlock: to, strict: true });
      return logs.map((l) => {
        if (l.removed) throw new Error("the node returned a removed log");
        return {
          besuBlock: l.args.besuBlock,
          commitment: l.args.blockHash.toLowerCase() as Hex,
          txHash: l.transactionHash.toLowerCase() as Hex,
          blockNumber: l.blockNumber,
          blockHash: l.blockHash.toLowerCase() as Hex,
          logIndex: l.logIndex,
        };
      });
    },
  };
}
