import { createPublicClient, http, type PublicClient } from "viem";
import type { Address, Hex } from "./deployment.ts";

/** A block header as the indexer needs it. */
export interface Header {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
  timestamp: bigint;
}

/** A raw log, before decoding. */
export interface RawLog {
  address: Address;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
  topics: Hex[];
  data: Hex;
  removed: boolean;
}

/** Where the indexer reads the chain from. The RPC implementation is below; tests use a fake. */
export interface ChainSource {
  chainId(): Promise<number>;
  head(): Promise<bigint>;
  /** Headers for every block in [from, to], ascending. */
  headers(from: bigint, to: bigint): Promise<Header[]>;
  /** Logs of the given contracts in [from, to]. */
  logs(addresses: readonly Address[], from: bigint, to: bigint): Promise<RawLog[]>;
}

interface RpcBlock {
  number: Hex;
  hash: Hex;
  parentHash: Hex;
  timestamp: Hex;
}

interface RpcLog {
  address: Hex;
  blockNumber: Hex;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: Hex;
  logIndex: Hex;
  topics: Hex[];
  data: Hex;
  removed?: boolean;
}

const hex = (n: bigint): Hex => `0x${n.toString(16)}`;

/** Plain JSON-RPC call returning the node's raw JSON (hex quantities), parsed by the caller. */
async function rawRequest<T>(client: PublicClient, method: string, params: unknown[]): Promise<T> {
  const request = client.request as unknown as (args: { method: string; params: unknown[] }) => Promise<T>;
  return request({ method, params });
}

/**
 * JSON-RPC source. Header requests go out as JSON-RPC batches (about 4,000 headers per second on
 * the local Besu network); logs are read with one eth_getLogs per window.
 */
export function rpcSource(url: string, opts: { timeoutMs?: number; batchSize?: number } = {}): ChainSource & { client: PublicClient } {
  const client = createPublicClient({
    transport: http(url, { timeout: opts.timeoutMs ?? 30_000, batch: { batchSize: opts.batchSize ?? 100 }, retryCount: 2 }),
  });
  return {
    client,
    chainId: () => client.getChainId(),
    head: () => client.getBlockNumber({ cacheTime: 0 }),
    async headers(from, to) {
      const requests: Promise<RpcBlock | null>[] = [];
      for (let n = from; n <= to; n++) {
        requests.push(rawRequest<RpcBlock | null>(client, "eth_getBlockByNumber", [hex(n), false]));
      }
      const blocks = await Promise.all(requests);
      return blocks.map((b, i) => {
        if (!b) throw new Error(`block ${String(from + BigInt(i))} is not available from the node`);
        return { number: BigInt(b.number), hash: b.hash, parentHash: b.parentHash, timestamp: BigInt(b.timestamp) };
      });
    },
    async logs(addresses, from, to) {
      const raw = await rawRequest<RpcLog[]>(client, "eth_getLogs", [{ address: [...addresses], fromBlock: hex(from), toBlock: hex(to) }]);
      return raw.map((l) => ({
        address: l.address,
        blockNumber: BigInt(l.blockNumber),
        blockHash: l.blockHash,
        transactionHash: l.transactionHash,
        transactionIndex: Number(l.transactionIndex),
        logIndex: Number(l.logIndex),
        topics: l.topics,
        data: l.data,
        removed: l.removed === true,
      }));
    },
  };
}
