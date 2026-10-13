import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { stateAnchorAbi } from "../abis";
import { db } from "./db";

/**
 * Public-chain anchors for the verification page (S-07 PV-20..PV-23, ADR 0008). Read-only:
 *  - the StateAnchor deployment from `python chain/anchor.py deploy` (local stand-in, chain 586650,
 *    until the owner chooses the L2, Q-1);
 *  - the anchor records with their components from schema `anchor` (needs the read role
 *    pt_anchor_reader, which the website's role does not have yet: shown as such, never guessed);
 *  - the committed value per anchor read from the anchor chain (`anchors(besuBlock)`). The browser
 *    cannot read that RPC itself (CSP `connect-src 'self'`), so this server reads it and the page
 *    says so; the recomputation of the commitment happens in the browser.
 * Every answer is cached for 30 s (anchors are hourly), so visitors never multiply RPC or DB load.
 */
export const LOCAL_ANCHOR_CHAIN_ID = 586_650;
const ANCHOR_CHAIN_ID = Number(process.env.ANCHOR_CHAIN_ID ?? LOCAL_ANCHOR_CHAIN_ID);
const ANCHOR_RPC_URL = process.env.ANCHOR_RPC_URL ?? "http://127.0.0.1:8650";
const REPO_ROOT = join(process.cwd(), "..");
const TTL_MS = 30_000;
const LIMIT = 12;

export interface PublicAnchor {
  id: string;
  besuChainId: string;
  besuBlock: string;
  besuBlockHash: Hex;
  ledgerJournalId: string;
  ledgerHeadHash: Hex;
  /** The commitment the platform recorded. */
  recorded: Hex;
  status: "recorded" | "sent" | "confirmed";
  txHash: Hex | null;
  anchorBlock: string | null;
  confirmedAt: string | null;
  /** `anchors(besuBlock)` on the anchor chain; null when unreadable, zero hash when not anchored. */
  publicValue: Hex | null;
}

export type AnchorSection =
  /** No anchor chain is deployed or configured for this server (e.g. the demo server). */
  | { state: "not-configured"; chainId: number }
  /** The website's database role may not read schema `anchor` (pending grant). */
  | { state: "no-access"; chainId: number; contract: Address }
  | { state: "unavailable"; chainId: number; contract: Address }
  | {
      state: "ok";
      chainId: number;
      contract: Address;
      /** The anchor chain answered with the configured chain ID. */
      publicReachable: boolean;
      lastAnchoredBlock: string | null;
      anchors: PublicAnchor[];
    };

let deploymentCache: { mtimeMs: number; value: Address | null } | null = null;

/** The StateAnchor address from DeployAnchor.s.sol's broadcast (as @pt/anchor's anchorDeploymentFromBroadcast). */
export function anchorContract(): Address | null {
  const fromEnv = process.env.ANCHOR_CONTRACT;
  if (fromEnv && /^0x[0-9a-fA-F]{40}$/.test(fromEnv)) return fromEnv.toLowerCase() as Address;
  const file = join(REPO_ROOT, "contracts", "broadcast", "DeployAnchor.s.sol", String(ANCHOR_CHAIN_ID), "run-latest.json");
  // Fixed path inside the repository, never user input.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (!existsSync(file)) return null;
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const mtimeMs = statSync(file).mtimeMs;
  if (deploymentCache?.mtimeMs === mtimeMs) return deploymentCache.value;
  let value: Address | null = null;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const run = JSON.parse(readFileSync(file, "utf8")) as { chain?: number; returns?: { anchor?: { value?: string } } };
    const a = run.returns?.anchor?.value;
    if ((run.chain === undefined || run.chain === ANCHOR_CHAIN_ID) && a && /^0x[0-9a-fA-F]{40}$/.test(a)) value = a.toLowerCase() as Address;
  } catch {
    value = null;
  }
  deploymentCache = { mtimeMs, value };
  return value;
}

const anchorClient = createPublicClient({ transport: http(ANCHOR_RPC_URL, { timeout: 3_000, retryCount: 0 }) });

interface Row {
  id: string;
  besu_chain_id: string;
  besu_block: string;
  besu_block_hash: Hex;
  ledger_journal_id: string;
  ledger_head_hash: Hex;
  commitment: Hex;
  status: PublicAnchor["status"];
  tx_hash: Hex | null;
  anchor_block: string | null;
  confirmed_at: Date | null;
}

async function readSection(): Promise<AnchorSection> {
  const contract = anchorContract();
  if (!contract) return { state: "not-configured", chainId: ANCHOR_CHAIN_ID };
  let rows: Row[];
  try {
    // Components and status only: never the signed transaction, nonce or sender.
    rows = (
      await (await db()).query<Row>(
        `SELECT id::text, besu_chain_id::text, besu_block::text, besu_block_hash, ledger_journal_id::text, ledger_head_hash,
                commitment, status, tx_hash, anchor_block::text, confirmed_at
         FROM anchor.anchors WHERE anchor_chain_id = $1 AND contract = $2 AND status <> 'failed'
         ORDER BY besu_block DESC LIMIT $3`,
        [ANCHOR_CHAIN_ID, contract, LIMIT],
      )
    ).rows;
  } catch (e) {
    const code = (e as { code?: string }).code;
    // 42501: permission denied (no read grant); 3F000/42P01: schema not migrated in this database.
    return code === "42501" ? { state: "no-access", chainId: ANCHOR_CHAIN_ID, contract } : { state: "unavailable", chainId: ANCHOR_CHAIN_ID, contract };
  }
  const publicReachable = await anchorClient
    .getChainId()
    .then((id) => id === ANCHOR_CHAIN_ID)
    .catch(() => false);
  const read = async (fn: () => Promise<Hex | bigint>): Promise<Hex | bigint | null> => (publicReachable ? fn().catch(() => null) : null);
  const [last, ...values] = await Promise.all([
    read(() => anchorClient.readContract({ address: contract, abi: stateAnchorAbi, functionName: "lastAnchoredBlock" })),
    ...rows.map((r) => read(() => anchorClient.readContract({ address: contract, abi: stateAnchorAbi, functionName: "anchors", args: [BigInt(r.besu_block)] }))),
  ]);
  return {
    state: "ok",
    chainId: ANCHOR_CHAIN_ID,
    contract,
    publicReachable,
    lastAnchoredBlock: typeof last === "bigint" ? last.toString() : null,
    anchors: rows.map((r, i) => {
      const v = values.at(i);
      return {
        id: r.id,
        besuChainId: r.besu_chain_id,
        besuBlock: r.besu_block,
        besuBlockHash: r.besu_block_hash,
        ledgerJournalId: r.ledger_journal_id,
        ledgerHeadHash: r.ledger_head_hash,
        recorded: r.commitment,
        status: r.status,
        txHash: r.tx_hash,
        anchorBlock: r.anchor_block,
        confirmedAt: r.confirmed_at?.toISOString() ?? null,
        publicValue: typeof v === "string" ? (v.toLowerCase() as Hex) : null,
      };
    }),
  };
}

let cache: { at: number; value: Promise<AnchorSection> } | null = null;

export function anchorSection(): Promise<AnchorSection> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const value = readSection().catch((): AnchorSection => ({ state: "not-configured", chainId: ANCHOR_CHAIN_ID }));
  cache = { at: Date.now(), value };
  return value;
}
