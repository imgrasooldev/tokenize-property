import type { Block } from "viem";
import { PROPERTIES } from "../properties";
import type { Pulse, PulseBlock } from "../pulse-view";
import { publicClient } from "./chain";
import { db } from "./db";
import { liveToken } from "./readmodel";
import { chainProblemsCached } from "./ledger";
import { marketSnapshot } from "./market";

/**
 * Public "network pulse" for the status rail, the live block row and the home page: the latest
 * blocks, validator count, the live token's price and supply, and the ledger hash-chain check.
 * Everything is read from the chain or the database; nothing is invented. One shared value per
 * second for all viewers (the same pattern as the market snapshot), so polling clients cannot
 * multiply the load on the chain or the database. No personal data.
 */
const TTL_MS = 1_000;
const ROW = 8;
/** Blocks are final under QBFT, so a block once read never changes. */
const blockCache = new Map<bigint, PulseBlock>();
let last: Pulse | null = null;
let pending: Promise<Pulse> | null = null;
let readAt = 0;

/**
 * Stale-while-revalidate: once a value exists, callers get it at once and at most one refresh runs
 * in the background, so a page never waits for the chain once the server is warm.
 */
export function chainPulse(): Promise<Pulse> {
  const fresh = Date.now() - readAt < TTL_MS;
  if (!fresh && !pending) {
    readAt = Date.now();
    pending = readPulse()
      .catch(() => EMPTY)
      .then((v) => {
        last = v;
        return v;
      })
      .finally(() => {
        pending = null;
      });
  }
  if (last) return Promise.resolve(last);
  return pending ?? Promise.resolve(EMPTY);
}

const EMPTY: Pulse = { ok: false, at: 0, blocks: [], blockSeconds: null, validators: null, market: null, ledgerOk: null };

function toPulseBlock(b: Block): PulseBlock {
  return {
    number: Number(b.number),
    hash: b.hash ?? "0x",
    time: Number(b.timestamp),
    txs: b.transactions.length,
  };
}

async function readBlocks(): Promise<PulseBlock[]> {
  const head = await publicClient.getBlockNumber({ cacheTime: 0 });
  const wanted: bigint[] = [];
  for (let n = head; n >= 0n && wanted.length < ROW; n--) wanted.push(n);
  const missing = wanted.filter((n) => !blockCache.has(n));
  const fetched = await Promise.all(missing.map((n) => publicClient.getBlock({ blockNumber: n })));
  for (const b of fetched) blockCache.set(b.number, toPulseBlock(b));
  // Keep the cache small: only the blocks still in the row.
  for (const n of blockCache.keys()) if (n < head - BigInt(ROW * 2)) blockCache.delete(n);
  return wanted.map((n) => blockCache.get(n)).filter((b): b is PulseBlock => b !== undefined);
}

async function readValidators(): Promise<number | null> {
  try {
    // Besu QBFT API (enabled on the local network: ETH, NET, WEB3, QBFT, TXPOOL).
    const v = (await publicClient.request({ method: "qbft_getValidatorsByBlockNumber" as never, params: ["latest"] as never })) as unknown;
    return Array.isArray(v) ? v.length : null;
  } catch {
    return null;
  }
}

async function readPulse(): Promise<Pulse> {
  const liveP = PROPERTIES.at(0);
  const [blocks, validators, snapshot, token, ledger] = await Promise.all([
    readBlocks().catch(() => [] as PulseBlock[]),
    readValidators(),
    liveP ? marketSnapshot(liveP.symbol).catch(() => null) : Promise.resolve(null),
    liveP ? liveToken(liveP.symbol) : Promise.resolve(null),
    db()
      .then((pool) => chainProblemsCached(pool))
      .catch(() => null),
  ]);
  const first = blocks.at(-1);
  const last = blocks.at(0);
  const blockSeconds = first && last && blocks.length > 1 ? (last.time - first.time) / (blocks.length - 1) : null;
  return {
    ok: blocks.length > 0,
    at: Date.now(),
    blocks,
    blockSeconds,
    validators,
    market: liveP
      ? {
          symbol: liveP.symbol,
          nav: liveP.navPkr,
          last: snapshot?.last === null || snapshot?.last === undefined ? null : Number(snapshot.last) / 100,
          supply: token ? Number(token.supply) : null,
          cap: token ? Number(token.cap) : null,
          address: token?.address ?? null,
        }
      : null,
    ledgerOk: ledger === null ? null : ledger === 0,
  };
}
