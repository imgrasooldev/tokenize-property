/** JSON shape of the public network pulse sent to the browser (no bigint, no personal data). */
export interface PulseBlock {
  number: number;
  hash: string;
  /** Unix seconds. */
  time: number;
  txs: number;
}

export interface Pulse {
  /** False when the chain could not be read. */
  ok: boolean;
  /** Server time (ms) when this pulse was read. */
  at: number;
  /** Newest first. */
  blocks: PulseBlock[];
  /** Average seconds between the blocks in the row. */
  blockSeconds: number | null;
  /** Validators in the QBFT set at the latest block. */
  validators: number | null;
  market: {
    symbol: string;
    nav: number;
    /** Last traded price in the demo market (rupees), null before the first trade. */
    last: number | null;
    supply: number | null;
    cap: number | null;
    address: string | null;
  } | null;
  /** Ledger hash chain intact (null when the database is unreachable). */
  ledgerOk: boolean | null;
  /** Public-anchoring status (anchor.web_status, migration 0025); null when not read. */
  anchor: PulseAnchor | null;
}

/** The anchoring status as the rail needs it (JSON: times are ms since the epoch). */
export type PulseAnchor =
  /** The website cannot read the anchor status (no grant, database down). */
  | { state: "unavailable" }
  /** No anchor recorded yet. */
  | { state: "none" }
  | {
      state: "ok";
      /** Anchor chain ID; 586650 is the local stand-in, not a public network. */
      chainId: number;
      /** Private block of the latest confirmed anchor. */
      besuBlock: string | null;
      confirmedAt: number | null;
      count: number;
      open: "none" | "pending" | "failed";
      /** Older than this (2 x the anchoring interval) is shown as late. */
      maxAgeMs: number;
    };

/** Anchor chain of the local stand-in (Anvil, ADR 0008) until the owner chooses the public L2. */
export const STAND_IN_ANCHOR_CHAIN_ID = 586_650;

export type AnchorTone = "fresh" | "late" | "failed" | "pending" | "none" | "unavailable";

/**
 * What the status rail shows for anchoring: green when the latest confirmed anchor is at most
 * 2 x the interval old, amber when older (or when none is confirmed yet while one is pending), red
 * when the newest anchor failed and none is open.
 */
export function anchorRail(a: PulseAnchor | null, nowMs: number): { tone: AnchorTone; ageMs: number | null; block: string | null; standIn: boolean } {
  if (!a || a.state === "unavailable") return { tone: "unavailable", ageMs: null, block: null, standIn: false };
  if (a.state === "none") return { tone: "none", ageMs: null, block: null, standIn: false };
  const standIn = a.chainId === STAND_IN_ANCHOR_CHAIN_ID;
  const ageMs = a.confirmedAt === null ? null : Math.max(0, nowMs - a.confirmedAt);
  const base = { ageMs, block: a.besuBlock, standIn };
  if (a.open === "failed") return { tone: "failed", ...base };
  if (ageMs === null) return { tone: a.open === "pending" ? "pending" : "none", ...base };
  return { tone: ageMs > a.maxAgeMs ? "late" : "fresh", ...base };
}

/** Formats a duration for "age" labels: minutes below two hours, then hours. */
export function ageParts(ms: number): { unit: "min" | "h"; value: number } {
  const min = Math.floor(ms / 60_000);
  return min < 120 ? { unit: "min", value: min } : { unit: "h", value: Math.floor(min / 60) };
}

/** A head block older than this means the network is not producing blocks. */
export const STALE_SECONDS = 15;

export function isHealthy(p: Pulse): boolean {
  const head = p.blocks.at(0);
  return p.ok && head !== undefined && p.at / 1000 - head.time < STALE_SECONDS;
}

export const shortHash = (h: string, a = 6, b = 4) => (h.length > a + b + 2 ? `${h.slice(0, a)}…${h.slice(-b)}` : h);
