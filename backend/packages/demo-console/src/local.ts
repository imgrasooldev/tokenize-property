import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readEnvFile } from "@pt/config";
import type { Address } from "viem";

export const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
export const CHAIN_ID = 586_586;
export const RPC_PORTS = [8545, 8546, 8547, 8548] as const;

/** Public addresses of the local demo roles. Keys in the same file are never read here. */
export function demoAddresses(): Map<string, Address> {
  const env = readEnvFile(`${ROOT}chain/network/dev-accounts.env`);
  const out = new Map<string, Address>();
  for (const [k, v] of Object.entries(env)) {
    if (k.endsWith("_KEY") || !/^0x[0-9a-fA-F]{40}$/.test(v)) continue;
    out.set(k, v as Address);
  }
  return out;
}

export interface Deployment {
  token: Address;
  ir: Address;
  issuance: Address;
  pauseGuard: Address;
  freezeGuard: Address;
  recovery: Address;
  registrarGuard: Address;
  distributions: Address;
  timelock: Address;
  fromBlock: bigint;
}

const NAMES = [
  "timelock", "oidAuthority", "trexAuthority", "idFactory", "factory", "claimIssuer", "countryModule",
  "maxBalanceModule", "token", "ir", "issuance", "pauseGuard", "freezeGuard", "recovery", "registrarGuard",
  "distributions", "documents",
] as const;

/** Addresses from the latest DeployLib broadcast on the local chain, or null if none yet. */
export function latestDeployment(): Deployment | null {
  const file = `${ROOT}contracts/broadcast/Deploy.s.sol/${CHAIN_ID}/run-latest.json`;
  // Fixed path inside the repository.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (!existsSync(file)) return null;
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const run = JSON.parse(readFileSync(file, "utf8")) as {
    returns?: { d?: { value?: string } };
    receipts?: { blockNumber?: string }[];
  };
  const values = run.returns?.d?.value?.match(/0x[0-9a-fA-F]{40}/g) ?? [];
  if (values.length !== NAMES.length) return null;
  const a = Object.fromEntries(NAMES.map((n, i) => [n, values.at(i) as Address])) as Record<
    (typeof NAMES)[number],
    Address
  >;
  const first = run.receipts?.[0]?.blockNumber;
  return {
    token: a.token,
    ir: a.ir,
    issuance: a.issuance,
    pauseGuard: a.pauseGuard,
    freezeGuard: a.freezeGuard,
    recovery: a.recovery,
    registrarGuard: a.registrarGuard,
    distributions: a.distributions,
    timelock: a.timelock,
    fromBlock: first ? BigInt(first) : 0n,
  };
}
