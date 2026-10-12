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
}

/** A head block older than this means the network is not producing blocks. */
export const STALE_SECONDS = 15;

export function isHealthy(p: Pulse): boolean {
  const head = p.blocks.at(0);
  return p.ok && head !== undefined && p.at / 1000 - head.time < STALE_SECONDS;
}

export const shortHash = (h: string, a = 6, b = 4) => (h.length > a + b + 2 ? `${h.slice(0, a)}…${h.slice(-b)}` : h);
