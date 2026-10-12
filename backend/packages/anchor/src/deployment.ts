import { existsSync, readFileSync } from "node:fs";
import type { Address } from "viem";

export interface AnchorDeployment {
  contract: Address;
  chainId: number;
  /** Block of the deployment receipt: no Anchored event can be earlier. */
  fromBlock: bigint;
}

/**
 * Reads the StateAnchor address from a DeployAnchor.s.sol broadcast file (run-latest.json), written by
 * `python chain/anchor.py deploy`. Returns null if the file does not exist or holds no StateAnchor.
 */
export function anchorDeploymentFromBroadcast(file: string, chainId: number): AnchorDeployment | null {
  // The path is our own broadcast file (or an operator-supplied one), never request input.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (!existsSync(file)) return null;
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const run = JSON.parse(readFileSync(file, "utf8")) as {
    chain?: number;
    returns?: { anchor?: { value?: string } };
    receipts?: { blockNumber?: string; contractAddress?: string | null }[];
  };
  const address = run.returns?.anchor?.value?.match(/^0x[0-9a-fA-F]{40}$/)?.[0];
  if (!address) return null;
  if (run.chain !== undefined && run.chain !== chainId) throw new Error(`broadcast ${file} is for chain ${String(run.chain)}, not ${String(chainId)}`);
  const receipt = run.receipts?.find((r) => r.contractAddress?.toLowerCase() === address.toLowerCase());
  if (!receipt?.blockNumber) return null;
  return { contract: address.toLowerCase() as Address, chainId, fromBlock: BigInt(receipt.blockNumber) };
}
