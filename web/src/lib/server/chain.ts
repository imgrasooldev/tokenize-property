import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, type Address } from "viem";
import { issuanceGuardAbi, tokenAbi } from "../abis";

/** Local dev chain only (DeployLib.LOCAL_DEV_CHAIN_ID). Production will read a hosted indexer. */
const CHAIN_ID = 586_586;
const RPC_URL = process.env.CHAIN_RPC_URL ?? "http://127.0.0.1:8545";
const REPO_ROOT = join(process.cwd(), "..");

const client = createPublicClient({ transport: http(RPC_URL, { timeout: 2_000 }) });

const NAMES = [
  "timelock", "oidAuthority", "trexAuthority", "idFactory", "factory", "claimIssuer", "countryModule",
  "maxBalanceModule", "token", "ir", "issuance", "pauseGuard", "freezeGuard", "recovery", "registrarGuard",
  "distributions", "documents",
] as const;
export type DeploymentName = (typeof NAMES)[number];

/** Addresses from the latest DeployLib broadcast on the local chain (written by chain/flow.py). */
export function latestDeployment(): Map<DeploymentName, Address> | null {
  const file = join(REPO_ROOT, "contracts", "broadcast", "Deploy.s.sol", String(CHAIN_ID), "run-latest.json");
  // Fixed path inside the repository, never user input.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (!existsSync(file)) return null;
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const run = JSON.parse(readFileSync(file, "utf8")) as { returns?: { d?: { value?: string } } };
  const values = run.returns?.d?.value?.match(/0x[0-9a-fA-F]{40}/g) ?? [];
  if (values.length !== NAMES.length) return null;
  return new Map(NAMES.map((n, i) => [n, values.at(i) as Address]));
}

export interface LiveToken {
  address: Address;
  supply: bigint;
  cap: bigint;
  paused: boolean;
  symbol: string;
}

/** Live figures for a property's token, or null when the chain or token is unavailable. */
export async function liveToken(symbol: string): Promise<LiveToken | null> {
  const d = latestDeployment();
  const token = d?.get("token");
  const issuance = d?.get("issuance");
  if (!token || !issuance) return null;
  try {
    const onChainSymbol = await client.readContract({ address: token, abi: tokenAbi, functionName: "symbol" });
    if (onChainSymbol !== symbol) return null;
    const [supply, cap, paused] = await Promise.all([
      client.readContract({ address: token, abi: tokenAbi, functionName: "totalSupply" }),
      client.readContract({ address: issuance, abi: issuanceGuardAbi, functionName: "trusteeCap" }),
      client.readContract({ address: token, abi: tokenAbi, functionName: "paused" }),
    ]);
    return { address: token, supply, cap, paused, symbol: onChainSymbol };
  } catch {
    return null;
  }
}
