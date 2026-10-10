import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import { z } from "zod";
import { distributionRegistryAbi } from "../abis";
import { latestDeployment } from "./chain";
import { publicClient } from "./demo-signer";

/**
 * Rent distributions: the chain holds the Merkle root, the total and the statement hash; the rent
 * statement with every investor's proof is published off chain (written by chain/rent.py into
 * chain/data/rent/). Anyone can check a statement against the chain; nothing here is trusted
 * without that check.
 */
const REPO_ROOT = join(process.cwd(), "..");
const RENT_DIR = join(REPO_ROOT, "chain", "data", "rent");
const HEX32 = /^0x[0-9a-f]{64}$/;

const statementFile = z.object({
  id: z.number().int().positive(),
  root: z.string().regex(HEX32),
  statementHash: z.string().regex(HEX32),
  statement: z.string().max(1_000_000),
  entitlements: z
    .array(
      z.object({
        wallet: z.string().regex(/^0x[0-9a-f]{40}$/),
        amountPaisa: z.number().int().positive(),
        tokens: z.number().int().positive(),
        proof: z.array(z.string().regex(HEX32)).max(64),
      }),
    )
    .max(100_000),
});
type StatementFile = z.infer<typeof statementFile>;

export const STATUS = ["none", "published", "rejected", "finalized", "paid"] as const;
export type DistributionStatus = (typeof STATUS)[number];

export interface Distribution {
  id: bigint;
  status: DistributionStatus;
  recordBlock: bigint;
  publishedAt: Date;
  root: Hex;
  totalPaisa: bigint;
  statementHash: Hex;
  /** This investor's line in the published statement, if there is one. */
  mine: { amountPaisa: bigint; tokens: bigint; proof: Hex[] } | null;
  statementAvailable: boolean;
}

function loadStatements(token: Address): Map<number, StatementFile> {
  const out = new Map<number, StatementFile>();
  // Fixed directory inside the repository; file names are filtered by the token address below.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (!existsSync(RENT_DIR)) return out;
  const prefix = `${token.toLowerCase()}-`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  for (const name of readdirSync(RENT_DIR)) {
    if (!name.startsWith(prefix) || !/^0x[0-9a-f]{40}-\d{1,9}\.json$/.test(name)) continue;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const parsed = statementFile.safeParse(JSON.parse(readFileSync(join(RENT_DIR, name), "utf8")));
      if (parsed.success) out.set(parsed.data.id, parsed.data);
    } catch {
      // A malformed statement is ignored; the chain stays the source of truth.
    }
  }
  return out;
}

/** All distributions of the current token, newest first, with this wallet's entitlement. */
export async function distributionsFor(wallet: Address): Promise<Distribution[] | null> {
  const d = latestDeployment();
  const registry = d?.get("distributions");
  const token = d?.get("token");
  if (!registry || !token) return null;
  try {
    const count = await publicClient.readContract({ address: registry, abi: distributionRegistryAbi, functionName: "distributionCount" });
    const statements = loadStatements(token);
    const out: Distribution[] = [];
    for (let id = count; id >= 1n && out.length < 24; id--) {
      const x = await publicClient.readContract({ address: registry, abi: distributionRegistryAbi, functionName: "getDistribution", args: [id] });
      if (x.token.toLowerCase() !== token.toLowerCase()) continue;
      const file = statements.get(Number(id));
      const line = file?.entitlements.find((e) => e.wallet === wallet.toLowerCase());
      out.push({
        id,
        status: STATUS[x.status] ?? "none",
        recordBlock: x.recordBlock,
        publishedAt: new Date(Number(x.publishedAt) * 1000),
        root: x.merkleRoot,
        totalPaisa: x.totalPaisa,
        statementHash: x.statementHash,
        mine: line ? { amountPaisa: BigInt(line.amountPaisa), tokens: BigInt(line.tokens), proof: line.proof as Hex[] } : null,
        statementAvailable: file !== undefined,
      });
    }
    return out;
  } catch {
    return null;
  }
}

export interface VerifyResult {
  /** The statement file hashes to the statement hash recorded on chain. */
  statementMatches: boolean;
  /** DistributionRegistry.verify(id, wallet, amount, proof) returned true. */
  proofValid: boolean;
  /** Control: the same proof with 1 paisa more must fail. */
  tamperedRejected: boolean;
  amountPaisa: bigint;
}

/** Checks an investor's entitlement against the chain; null if there is nothing to check. */
export async function verifyEntitlement(wallet: Address, id: bigint): Promise<VerifyResult | null> {
  const d = latestDeployment();
  const registry = d?.get("distributions");
  const token = d?.get("token");
  if (!registry || !token) return null;
  const file = loadStatements(token).get(Number(id));
  const line = file?.entitlements.find((e) => e.wallet === wallet.toLowerCase());
  if (!file || !line) return null;
  const onChain = await publicClient.readContract({ address: registry, abi: distributionRegistryAbi, functionName: "getDistribution", args: [id] });
  const amount = BigInt(line.amountPaisa);
  const proof = line.proof as Hex[];
  const [proofValid, tampered] = await Promise.all([
    publicClient.readContract({ address: registry, abi: distributionRegistryAbi, functionName: "verify", args: [id, wallet, amount, proof] }),
    publicClient.readContract({ address: registry, abi: distributionRegistryAbi, functionName: "verify", args: [id, wallet, amount + 1n, proof] }),
  ]);
  return {
    statementMatches: keccak256(stringToBytes(file.statement)) === onChain.statementHash,
    proofValid,
    tamperedRejected: !tampered,
    amountPaisa: amount,
  };
}
