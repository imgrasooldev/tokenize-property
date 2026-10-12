import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Contracts whose events the indexer reads, by role. Matches chain.contracts.role. */
export const ROLES = [
  "token",
  "identityRegistry",
  "issuance",
  "pauseGuard",
  "freezeGuard",
  "recovery",
  "registrarGuard",
  "distributions",
  "documents",
  "timelock",
  "idFactory",
] as const;
export type Role = (typeof ROLES)[number];

export type Hex = `0x${string}`;
export type Address = `0x${string}`;

/** One property's contracts on one chain: the unit the indexer follows. */
export interface Deployment {
  /** Stable name, e.g. the token address. Matches chain.deployments.deployment. */
  id: string;
  chainId: number;
  /** First block that can hold an event of these contracts (the first deployment receipt). */
  fromBlock: bigint;
  /** Lower-case addresses by role; `token` is required. */
  contracts: Partial<Record<Role, Address>> & { token: Address };
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const deploymentSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,79}$/),
  chainId: z.number().int().positive(),
  fromBlock: z.bigint().nonnegative(),
  contracts: z
    .partialRecord(z.enum(ROLES), z.string().regex(ADDRESS))
    .refine((c) => typeof c.token === "string", "token address is required")
    .refine((c) => new Set(Object.values(c).map((a) => a.toLowerCase())).size === Object.keys(c).length, "addresses must be distinct"),
});

/** Validates a deployment and lower-cases its addresses. */
export function parseDeployment(input: unknown): Deployment {
  const parsed = deploymentSchema.safeParse(input);
  if (!parsed.success) throw new Error(`invalid deployment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const contracts = Object.fromEntries(Object.entries(parsed.data.contracts).map(([k, v]) => [k, v.toLowerCase()])) as Deployment["contracts"];
  return { id: parsed.data.id, chainId: parsed.data.chainId, fromBlock: parsed.data.fromBlock, contracts };
}

/** Role of every address, for routing logs to the right ABI. */
export function rolesByAddress(d: Deployment): Map<string, Role> {
  return new Map(Object.entries(d.contracts).map(([role, address]) => [address.toLowerCase(), role as Role]));
}

/** Order of the addresses in DeployLib.Deployment (contracts/script/DeployLib.sol), as returned by Deploy.s.sol. */
const BROADCAST_FIELDS = [
  "timelock", "oidAuthority", "trexAuthority", "idFactory", "factory", "claimIssuer", "countryModule",
  "maxBalanceModule", "token", "ir", "issuance", "pauseGuard", "freezeGuard", "recovery", "registrarGuard",
  "distributions", "documents",
] as const;

const FIELD_ROLE = new Map<string, Role>([
  ["timelock", "timelock"],
  ["idFactory", "idFactory"],
  ["token", "token"],
  ["ir", "identityRegistry"],
  ["issuance", "issuance"],
  ["pauseGuard", "pauseGuard"],
  ["freezeGuard", "freezeGuard"],
  ["recovery", "recovery"],
  ["registrarGuard", "registrarGuard"],
  ["distributions", "distributions"],
  ["documents", "documents"],
]);

export const LOCAL_BROADCAST = fileURLToPath(
  new URL("../../../../contracts/broadcast/Deploy.s.sol/586586/run-latest.json", import.meta.url),
);

/**
 * Reads a deployment from a DeployLib broadcast file (Deploy.s.sol run-latest.json). The start
 * block is the first receipt, so no event of these contracts is earlier. Returns null if the file
 * does not exist or does not look like a DeployLib run.
 */
export function deploymentFromBroadcast(file: string = LOCAL_BROADCAST, chainId = 586_586): Deployment | null {
  // The path is our own broadcast file (or an operator-supplied one), never request input.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (!existsSync(file)) return null;
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const run = JSON.parse(readFileSync(file, "utf8")) as {
    returns?: { d?: { value?: string } };
    receipts?: { blockNumber?: string }[];
  };
  const values = run.returns?.d?.value?.match(/0x[0-9a-fA-F]{40}/g) ?? [];
  const first = run.receipts?.[0]?.blockNumber;
  if (values.length !== BROADCAST_FIELDS.length || !first) return null;
  const entries: [Role, string][] = [];
  BROADCAST_FIELDS.forEach((field, i) => {
    const role = FIELD_ROLE.get(field);
    const address = values.at(i);
    if (role && address) entries.push([role, address]);
  });
  const contracts = Object.fromEntries(entries);
  const token = (entries.find(([r]) => r === "token")?.[1] ?? "").toLowerCase();
  return parseDeployment({ id: token, chainId, fromBlock: BigInt(first), contracts });
}
