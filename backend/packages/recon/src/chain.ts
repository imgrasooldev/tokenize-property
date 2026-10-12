import { tokenAbi } from "@pt/contracts";
import type { PublicClient } from "viem";

/** The contract reads reconciliation makes, always at one pinned block. Tests use a fake. */
export interface ChainState {
  head(): Promise<bigint>;
  totalSupply(token: string, block: bigint): Promise<bigint>;
  /** balanceOf for each holder at `block`. */
  balances(token: string, holders: readonly string[], block: bigint): Promise<Map<string, bigint>>;
}

/**
 * Reads from a node with viem. Besu with Bonsai storage keeps recent state only, so the pinned
 * block (the read model's cursor) must be near the head: keep the indexer running.
 */
export function viemChainState(client: PublicClient): ChainState {
  return {
    head: () => client.getBlockNumber({ cacheTime: 0 }),
    totalSupply: (token, block) => client.readContract({ address: token as `0x${string}`, abi: tokenAbi, functionName: "totalSupply", blockNumber: block }),
    async balances(token, holders, block) {
      const out = new Map<string, bigint>();
      for (let i = 0; i < holders.length; i += 100) {
        const chunk = holders.slice(i, i + 100);
        const values = await Promise.all(chunk.map(async (h) =>
          client.readContract({ address: token as `0x${string}`, abi: tokenAbi, functionName: "balanceOf", args: [h as `0x${string}`], blockNumber: block })));
        chunk.forEach((h, k) => out.set(h, values.at(k) ?? 0n));
      }
      return out;
    },
  };
}
