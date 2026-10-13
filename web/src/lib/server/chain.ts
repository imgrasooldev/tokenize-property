import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, defineChain, http, type Address, type Hex } from "viem";
import { idFactoryAbi, issuanceGuardAbi } from "../abis";

/**
 * Deployment addresses and the few DIRECT chain reads the website keeps (ADR 0010 §1). Everything
 * else is read from the indexer's read model (readmodel.ts). The website holds no key and never
 * sends a transaction; these reads exist only where a fresh on-chain check is the point:
 *  - proof that a recorded transaction can never execute, before money is returned (txOutcome);
 *  - rent self-verification (rent.ts);
 *  - a new investor's ONCHAINID address during onboarding (background, follower.ts);
 *  - the network status rail (pulse.ts: latest blocks and validators, one shared value per second).
 */
export const LOCAL_CHAIN_ID = 586_586;
const RPC_URL = process.env.CHAIN_RPC_URL ?? "http://127.0.0.1:8545";
const REPO_ROOT = join(process.cwd(), "..");

export const localChain = defineChain({
  id: LOCAL_CHAIN_ID,
  name: "Local Besu (dev)",
  nativeCurrency: { name: "Dev", symbol: "DEV", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

/** Read-only client. Blocks come every 2 s; poll every 250 ms instead of viem's 4 s default. */
export const publicClient = createPublicClient({ chain: localChain, transport: http(RPC_URL, { timeout: 5_000 }), pollingInterval: 250 });

const NAMES = [
  "timelock", "oidAuthority", "trexAuthority", "idFactory", "factory", "claimIssuer", "countryModule",
  "maxBalanceModule", "token", "ir", "issuance", "pauseGuard", "freezeGuard", "recovery", "registrarGuard",
  "distributions", "documents",
] as const;
export type DeploymentName = (typeof NAMES)[number];

let deploymentCache: { mtimeMs: number; value: Map<DeploymentName, Address> | null } | null = null;

/** Addresses from the latest DeployLib broadcast on the local chain (written by chain/flow.py). */
export function latestDeployment(): Map<DeploymentName, Address> | null {
  const file = join(REPO_ROOT, "contracts", "broadcast", "Deploy.s.sol", String(LOCAL_CHAIN_ID), "run-latest.json");
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

function readDeployment(file: string): Map<DeploymentName, Address> | null {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const run = JSON.parse(readFileSync(file, "utf8")) as { returns?: { d?: { value?: string } } };
  const values = run.returns?.d?.value?.match(/0x[0-9a-fA-F]{40}/g) ?? [];
  if (values.length !== NAMES.length) return null;
  return new Map(NAMES.map((n, i) => [n, (values.at(i) ?? "").toLowerCase() as Address]));
}

/** The indexer's deployment id for the local deployment: the token address (lower case). */
export function deploymentId(): string | null {
  return latestDeployment()?.get("token") ?? null;
}

export type TxOutcome = "success" | "reverted" | "dropped" | "pending" | "unknown";

/**
 * What became of a recorded transaction (a fresh chain check, used only before returning money):
 * - "success" / "reverted": it has a receipt;
 * - "dropped": no receipt and the sender's mined nonce is past it, so it can never be mined;
 * - "pending": the node still holds it; "unknown": neither, or any RPC error.
 */
export async function txOutcome(hash: Hex, from: Address, nonce: bigint): Promise<TxOutcome> {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => null);
    if (receipt) return receipt.status === "success" ? "success" : "reverted";
    const mined = await publicClient.getTransactionCount({ address: from, blockTag: "latest" });
    if (BigInt(mined) > nonce) return "dropped";
    const inPool = await publicClient.getTransaction({ hash }).catch(() => null);
    return inPool ? "pending" : "unknown";
  } catch {
    return "unknown";
  }
}

/** Block of a mined transaction, or null (unknown or not mined). */
export async function txBlock(hash: Hex): Promise<bigint | null> {
  const r = await publicClient.getTransactionReceipt({ hash }).catch(() => null);
  return r ? r.blockNumber : null;
}

/** IssuanceGuard.refUsed(refId) on chain; null if the chain cannot be read. */
export async function refUsedOnChain(refId: Hex): Promise<boolean | null> {
  const issuance = latestDeployment()?.get("issuance");
  if (!issuance) return null;
  return publicClient.readContract({ address: issuance, abi: issuanceGuardAbi, functionName: "refUsed", args: [refId] }).catch(() => null);
}

/** IdFactory.getIdentity(wallet): null if none or the chain cannot be read. */
export async function identityOnChain(wallet: Address): Promise<Address | null> {
  const idFactory = latestDeployment()?.get("idFactory");
  if (!idFactory) return null;
  const id = await publicClient.readContract({ address: idFactory, abi: idFactoryAbi, functionName: "getIdentity", args: [wallet] }).catch(() => null);
  return id && !/^0x0{40}$/i.test(id) ? (id.toLowerCase() as Address) : null;
}
