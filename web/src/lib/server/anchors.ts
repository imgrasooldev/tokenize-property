import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { stateAnchorAbi } from "../abis";
import { STAND_IN_ANCHOR_CHAIN_ID, type PulseAnchor } from "../pulse-view";
import { anchorIntervalSeconds } from "../verify-rules";
import { db } from "./db";

/**
 * Public-chain anchors for the verification page and the status rail (S-07 PV-20..PV-23, ADR 0008,
 * task T-047). Read-only:
 *  - the anchor records through anchor.web_status() and anchor.web_recent(n) (migration 0025 WN-1:
 *    the website's role may call these two functions and nothing else in schema `anchor`; public
 *    values only, never the signed transaction, nonce, sender or failure reason);
 *  - the committed value per anchor read from the anchor chain (`anchors(besuBlock)`). The browser
 *    cannot read that RPC itself (CSP `connect-src 'self'`), so this server reads it and the page
 *    says so; the recomputation of the commitment happens in the browser.
 * The anchor chain is the local stand-in (Anvil, chain 586650) until the owner chooses the public
 * L2 (ADR 0008, Q-1); the page and the rail say so and never call it a public network.
 * Every answer is cached (anchors are every 15 min to hourly), so visitors never multiply RPC or DB load.
 */
export const LOCAL_ANCHOR_CHAIN_ID = STAND_IN_ANCHOR_CHAIN_ID;
const ANCHOR_CHAIN_ID = Number(process.env.ANCHOR_CHAIN_ID ?? LOCAL_ANCHOR_CHAIN_ID);
const ANCHOR_RPC_URL = process.env.ANCHOR_RPC_URL ?? "http://127.0.0.1:8650";
const REPO_ROOT = join(process.cwd(), "..");
const TTL_MS = 30_000;
const RAIL_TTL_MS = 15_000;
const LIMIT = 12;

/** 2 x the anchoring interval (ANCHOR_INTERVAL_SECONDS, as the anchoring job; default hourly). */
export function anchorMaxAgeMs(): number {
  return 2 * anchorIntervalSeconds(process.env.ANCHOR_INTERVAL_SECONDS) * 1000;
}

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

/** anchor.web_status(): the latest confirmed anchor and a coarse state of the newest one. */
export interface AnchorStatus {
  besuBlock: string | null;
  commitment: Hex | null;
  txHash: Hex | null;
  anchorBlock: string | null;
  confirmedAt: string | null;
  count: number;
  ageSeconds: number | null;
  open: "none" | "pending" | "failed";
  openSince: string | null;
}

export type AnchorSection =
  /** The website's database role may not read the anchor status (database without migration 0025). */
  | { state: "no-access"; chainId: number; contract: Address | null }
  | { state: "unavailable"; chainId: number; contract: Address | null }
  /** No anchor recorded yet; `contract` is the configured StateAnchor, if any. */
  | { state: "none"; chainId: number; contract: Address | null }
  | {
      state: "ok";
      chainId: number;
      contract: Address;
      /** The anchor chain answered with the anchors' chain ID. */
      publicReachable: boolean;
      lastAnchoredBlock: string | null;
      status: AnchorStatus;
      /** Older than this is shown as late (2 x the anchoring interval). */
      maxAgeMs: number;
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

interface StatusRow {
  anchor_chain_id: string;
  contract: Address;
  besu_block: string | null;
  commitment: Hex | null;
  tx_hash: Hex | null;
  anchor_block: string | null;
  confirmed_at: Date | null;
  confirmed_count: string;
  age_seconds: string | null;
  open_state: AnchorStatus["open"];
  open_since: Date | null;
}

interface RecentRow {
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

type StatusRead = { kind: "denied" } | { kind: "error" } | { kind: "none" } | { kind: "ok"; chainId: number; contract: Address; status: AnchorStatus };

/** Migration 0025 WN-2: one row for the current anchor target, or none before the first anchor. */
async function readStatus(): Promise<StatusRead> {
  try {
    const { rows } = await (await db()).query<StatusRow>(
      `SELECT anchor_chain_id::text, contract, besu_block::text, commitment, tx_hash, anchor_block::text, confirmed_at,
              confirmed_count::text, age_seconds::text, open_state, open_since
       FROM anchor.web_status()`,
    );
    const r = rows.at(0);
    if (!r) return { kind: "none" };
    return {
      kind: "ok",
      chainId: Number(r.anchor_chain_id),
      contract: r.contract,
      status: {
        besuBlock: r.besu_block,
        commitment: r.commitment,
        txHash: r.tx_hash,
        anchorBlock: r.anchor_block,
        confirmedAt: r.confirmed_at?.toISOString() ?? null,
        count: Number(r.confirmed_count),
        ageSeconds: r.age_seconds === null ? null : Number(r.age_seconds),
        open: r.open_state,
        openSince: r.open_since?.toISOString() ?? null,
      },
    };
  } catch (e) {
    const code = (e as { code?: string }).code;
    // 42501: no grant; 42883: function missing (database before 0025); 3F000: schema missing.
    return code === "42501" || code === "42883" || code === "3F000" ? { kind: "denied" } : { kind: "error" };
  }
}

async function readSection(): Promise<AnchorSection> {
  const configured = anchorContract();
  const s = await readStatus();
  if (s.kind === "denied") return { state: "no-access", chainId: ANCHOR_CHAIN_ID, contract: configured };
  if (s.kind === "error") return { state: "unavailable", chainId: ANCHOR_CHAIN_ID, contract: configured };
  if (s.kind === "none") return { state: "none", chainId: ANCHOR_CHAIN_ID, contract: configured };
  let rows: RecentRow[];
  try {
    // Components, commitment and public transaction only (WN-2); at most 20 rows (WN-4).
    rows = (
      await (await db()).query<RecentRow>(
        `SELECT id::text, besu_chain_id::text, besu_block::text, besu_block_hash, ledger_journal_id::text, ledger_head_hash,
                commitment, status, tx_hash, anchor_block::text, confirmed_at
         FROM anchor.web_recent($1)`,
        [LIMIT],
      )
    ).rows;
  } catch {
    return { state: "unavailable", chainId: s.chainId, contract: s.contract };
  }
  const publicReachable = await anchorClient
    .getChainId()
    .then((id) => id === s.chainId)
    .catch(() => false);
  const read = async (fn: () => Promise<Hex | bigint>): Promise<Hex | bigint | null> => (publicReachable ? fn().catch(() => null) : null);
  const [last, ...values] = await Promise.all([
    read(() => anchorClient.readContract({ address: s.contract, abi: stateAnchorAbi, functionName: "lastAnchoredBlock" })),
    ...rows.map((r) => read(() => anchorClient.readContract({ address: s.contract, abi: stateAnchorAbi, functionName: "anchors", args: [BigInt(r.besu_block)] }))),
  ]);
  return {
    state: "ok",
    chainId: s.chainId,
    contract: s.contract,
    publicReachable,
    lastAnchoredBlock: typeof last === "bigint" ? last.toString() : null,
    status: s.status,
    maxAgeMs: anchorMaxAgeMs(),
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
  const value = readSection().catch((): AnchorSection => ({ state: "unavailable", chainId: ANCHOR_CHAIN_ID, contract: null }));
  cache = { at: Date.now(), value };
  return value;
}

let railCache: { at: number; value: Promise<PulseAnchor> } | null = null;

/** The status rail's anchoring state (database only, no RPC): one shared value per 15 s. */
export function anchorRailStatus(): Promise<PulseAnchor> {
  if (railCache && Date.now() - railCache.at < RAIL_TTL_MS) return railCache.value;
  const value = readStatus()
    .then((s): PulseAnchor => {
      if (s.kind === "none") return { state: "none" };
      if (s.kind !== "ok") return { state: "unavailable" };
      return {
        state: "ok",
        chainId: s.chainId,
        besuBlock: s.status.besuBlock,
        confirmedAt: s.status.confirmedAt === null ? null : Date.parse(s.status.confirmedAt),
        count: s.status.count,
        open: s.status.open,
        maxAgeMs: anchorMaxAgeMs(),
      };
    })
    .catch((): PulseAnchor => ({ state: "unavailable" }));
  railCache = { at: Date.now(), value };
  return value;
}

/** Tests only: forget cached answers (the database behind the pool changed). */
export function resetAnchorCaches(): void {
  cache = null;
  railCache = null;
}
