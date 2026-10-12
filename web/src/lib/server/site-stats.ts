import { zeroAddress } from "viem";
import { db } from "./db";
import { distributionsFor, type Distribution } from "./rent";

/**
 * Public, aggregate figures for the home page, all read from the prototype's own records:
 * verified investors and settled trades from the demo database, the latest issuance (no investor
 * identity), and the rent distributions published on chain. Cached for 10 s across viewers.
 */
export interface SiteStats {
  verifiedInvestors: number | null;
  tradesSettled: number | null;
  lastMint: { symbol: string; tokens: number; tx: string; at: string } | null;
  lastTrade: { symbol: string; tokens: number; pricePaisa: number; tx: string; at: string } | null;
  /** Newest first; null when the chain is unavailable. */
  distributions: Pick<Distribution, "id" | "status" | "publishedAt" | "root" | "totalPaisa" | "statementHash">[] | null;
}

const TTL_MS = 10_000;
let last: SiteStats | null = null;
let pending: Promise<SiteStats> | null = null;
let readAt = 0;

/** Stale-while-revalidate (see chainPulse): pages never wait for a refresh once a value exists. */
export function siteStats(): Promise<SiteStats> {
  if (Date.now() - readAt >= TTL_MS && !pending) {
    readAt = Date.now();
    pending = readStats()
      .catch((): SiteStats => last ?? { verifiedInvestors: null, tradesSettled: null, lastMint: null, lastTrade: null, distributions: null })
      .then((v) => {
        last = v;
        return v;
      })
      .finally(() => {
        pending = null;
      });
  }
  if (last) return Promise.resolve(last);
  return pending ?? readStats();
}

async function readStats(): Promise<SiteStats> {
  const pool = await db().catch(() => null);
  const q = async <T>(sql: string): Promise<T | null> => {
    if (!pool) return null;
    try {
      const { rows } = await pool.query(sql);
      return (rows[0] as T | undefined) ?? null;
    } catch {
      return null;
    }
  };
  const [investors, trades, mint, trade, dists] = await Promise.all([
    q<{ n: string }>("SELECT count(*) AS n FROM webdemo.investors WHERE kyc_status = 'verified'"),
    q<{ n: string }>("SELECT count(*) AS n FROM webdemo.trades WHERE status = 'settled'"),
    q<{ symbol: string; tokens: string; mint_tx: string; updated_at: Date }>(
      "SELECT symbol, tokens, mint_tx, updated_at FROM webdemo.subscriptions WHERE status = 'done' AND mint_tx IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
    ),
    q<{ symbol: string; tokens: string; price_paisa: string; transfer_tx: string; updated_at: Date }>(
      "SELECT symbol, tokens, price_paisa, transfer_tx, updated_at FROM webdemo.trades WHERE status = 'settled' AND transfer_tx IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
    ),
    // The zero address holds no entitlement, so this returns only the public part of each distribution.
    distributionsFor(zeroAddress),
  ]);
  return {
    verifiedInvestors: investors ? Number(investors.n) : null,
    tradesSettled: trades ? Number(trades.n) : null,
    lastMint: mint ? { symbol: mint.symbol, tokens: Number(mint.tokens), tx: mint.mint_tx, at: mint.updated_at.toISOString() } : null,
    lastTrade: trade
      ? { symbol: trade.symbol, tokens: Number(trade.tokens), pricePaisa: Number(trade.price_paisa), tx: trade.transfer_tx, at: trade.updated_at.toISOString() }
      : null,
    distributions: dists
      ? dists.map((d) => ({ id: d.id, status: d.status, publishedAt: d.publishedAt, root: d.root, totalPaisa: d.totalPaisa, statementHash: d.statementHash }))
      : null,
  };
}
