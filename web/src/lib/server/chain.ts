import { existsSync, readFileSync, statSync } from "node:fs";
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

let deploymentCache: { mtimeMs: number; value: Map<DeploymentName, Address> | null } | null = null;

/** Addresses from the latest DeployLib broadcast on the local chain (written by chain/flow.py). */
export function latestDeployment(): Map<DeploymentName, Address> | null {
  const file = join(REPO_ROOT, "contracts", "broadcast", "Deploy.s.sol", String(CHAIN_ID), "run-latest.json");
  // Fixed path inside the repository, never user input.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (!existsSync(file)) return null;
  // Re-read only when a new deployment rewrote the file.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const mtimeMs = statSync(file).mtimeMs;
  if (deploymentCache?.mtimeMs === mtimeMs) return deploymentCache.value;
  deploymentCache = { mtimeMs, value: readDeployment(file) };
  return deploymentCache.value;
}

let deploymentBlock = 0n;

function readDeployment(file: string): Map<DeploymentName, Address> | null {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const run = JSON.parse(readFileSync(file, "utf8")) as {
    returns?: { d?: { value?: string } };
    receipts?: { blockNumber?: string }[];
  };
  const values = run.returns?.d?.value?.match(/0x[0-9a-fA-F]{40}/g) ?? [];
  if (values.length !== NAMES.length) return null;
  const first = run.receipts?.[0]?.blockNumber;
  deploymentBlock = first && /^0x[0-9a-fA-F]+$/.test(first) ? BigInt(first) : 0n;
  return new Map(NAMES.map((n, i) => [n, values.at(i) as Address]));
}

/** Block of the first deployment transaction: no contract event can be older. */
export function deploymentFromBlock(): bigint {
  latestDeployment();
  return deploymentBlock;
}

/**
 * Besu refuses eth_getLogs ranges over 5,000 blocks (rpc-max-logs-range). Walks [from, latest] in
 * windows small enough for that limit and concatenates the results in block order.
 */
export async function inBlockWindows<T>(from: bigint, read: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>): Promise<T[]> {
  const WINDOW = 4_000n;
  const latest = await client.getBlockNumber();
  const out: T[] = [];
  for (let start = from; start <= latest; start += WINDOW) {
    const end = start + WINDOW - 1n < latest ? start + WINDOW - 1n : latest;
    out.push(...(await read(start, end)));
  }
  return out;
}

export interface LiveToken {
  address: Address;
  supply: bigint;
  cap: bigint;
  paused: boolean;
  symbol: string;
}

const TOKEN_TTL_MS = 1_500;
const tokenCache = new Map<string, { at: number; value: Promise<LiveToken | null> }>();

/**
 * Live figures for a property's token, or null when the chain or token is unavailable.
 * Pages may use a value up to 1.5 s old (`fresh = false`); every money-moving pre-check passes
 * `fresh = true`, and the contracts re-check every rule regardless.
 */
export async function liveToken(symbol: string, fresh = false): Promise<LiveToken | null> {
  const hit = tokenCache.get(symbol);
  if (!fresh && hit && Date.now() - hit.at < TOKEN_TTL_MS) return hit.value;
  const value = readLiveToken(symbol);
  tokenCache.set(symbol, { at: Date.now(), value });
  const out = await value;
  if (out === null) tokenCache.delete(symbol); // do not cache an outage
  return out;
}

async function readLiveToken(symbol: string): Promise<LiveToken | null> {
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
