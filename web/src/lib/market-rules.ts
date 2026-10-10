import { z } from "zod";
import { MAX_HOLDING_TOKENS, MIN_TOKENS } from "./invest-rules";

/** Orders must be priced within ±10% of the latest NAV (circuit breaker). */
export const PRICE_BAND_BPS = 1_000n;

/** Largest single demo top-up: Rs 10,000,000. */
export const MAX_TOPUP_PAISA = 1_000_000_000n;

export type Side = "buy" | "sell";

/** Parses "505", "505.5" or "505.25" rupees into paisa; null for anything else (no floats involved). */
export function parseRupees(input: string): bigint | null {
  const s = input.trim();
  const parts = s.split(".");
  const whole = parts[0] ?? "";
  const frac = parts[1] ?? "";
  if (parts.length > 2 || !/^[1-9][0-9]{0,6}$/.test(whole)) return null;
  if (parts.length === 2 && !/^[0-9]{1,2}$/.test(frac)) return null;
  return BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0"));
}

const rupees = z.string().transform((s, ctx) => {
  const v = parseRupees(s);
  if (v === null) {
    ctx.addIssue({ code: "custom", message: "price in rupees, up to 2 decimals" });
    return z.NEVER;
  }
  return v;
});

export const orderSchema = z.object({
  symbol: z.string().regex(/^[A-Z][A-Z0-9]{2,11}$/),
  side: z.enum(["buy", "sell"]),
  price: rupees,
  tokens: z
    .string()
    .trim()
    .regex(/^[1-9][0-9]{0,5}$/, "whole number of tokens")
    .transform((s) => BigInt(s)),
  requestId: z.uuid({ version: "v4" }),
});

export const topUpSchema = z.object({
  amount: z
    .string()
    .trim()
    .regex(/^[1-9][0-9]{0,7}$/, "whole rupees")
    .transform((s) => BigInt(s) * 100n),
  requestId: z.uuid({ version: "v4" }),
  bankConfirm: z.literal("on"),
});

/** Inclusive price band in paisa around a NAV given in whole rupees. */
export function priceBand(navPkr: number): { min: bigint; max: bigint } {
  const nav = BigInt(navPkr) * 100n;
  return { min: (nav * (10_000n - PRICE_BAND_BPS) + 9_999n) / 10_000n, max: (nav * (10_000n + PRICE_BAND_BPS)) / 10_000n };
}

export type OrderProblem = "min" | "maxOrder" | "band" | "maxHolding" | "noTokens" | "noCash" | "selfTrade";

/** Off-chain checks for a new order. The ledger (cash) and the token contract repeat the hard ones. */
export function checkNewOrder(o: {
  side: Side;
  tokens: bigint;
  pricePaisa: bigint;
  navPkr: number;
  /** Chain balance minus tokens already offered in open sell orders. */
  freeTokens: bigint;
  /** Chain balance plus tokens still to arrive from open buy orders. */
  committedHolding: bigint;
  cashPaisa: bigint;
  /** Best opposite price from the investor's own open orders, if any. */
  ownOppositeBest: bigint | null;
}): OrderProblem | null {
  if (o.tokens < MIN_TOKENS) return "min";
  if (o.tokens > MAX_HOLDING_TOKENS) return "maxOrder";
  const band = priceBand(o.navPkr);
  if (o.pricePaisa < band.min || o.pricePaisa > band.max) return "band";
  if (o.side === "sell") {
    if (o.tokens > o.freeTokens) return "noTokens";
    if (o.ownOppositeBest !== null && o.pricePaisa <= o.ownOppositeBest) return "selfTrade";
  } else {
    if (o.committedHolding + o.tokens > MAX_HOLDING_TOKENS) return "maxHolding";
    if (o.tokens * o.pricePaisa > o.cashPaisa) return "noCash";
    if (o.ownOppositeBest !== null && o.pricePaisa >= o.ownOppositeBest) return "selfTrade";
  }
  return null;
}

export interface BookOrder {
  id: string;
  investorId: string;
  pricePaisa: bigint;
  remaining: bigint;
  createdAt: Date;
}

/**
 * Price-time priority: the best bid and best ask trade if they cross, at the price of the order
 * that was in the book first (the maker). Returns null when nothing crosses.
 */
export function nextMatch(bid: BookOrder | undefined, ask: BookOrder | undefined): { pricePaisa: bigint; tokens: bigint } | null {
  if (!bid || !ask || bid.pricePaisa < ask.pricePaisa || bid.investorId === ask.investorId) return null;
  const tokens = bid.remaining < ask.remaining ? bid.remaining : ask.remaining;
  if (tokens <= 0n) return null;
  const pricePaisa = bid.createdAt <= ask.createdAt ? bid.pricePaisa : ask.pricePaisa;
  return { pricePaisa, tokens };
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** One-minute candles from trades (prices in rupees). Trades must be in time order. */
export function candles(trades: { at: Date; pricePaisa: bigint; tokens: bigint }[], bucketSeconds = 60): Candle[] {
  const out: Candle[] = [];
  for (const t of trades) {
    const time = Math.floor(t.at.getTime() / 1000 / bucketSeconds) * bucketSeconds;
    const price = Number(t.pricePaisa) / 100;
    const last = out.at(-1);
    if (last?.time === time) {
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
      last.volume += Number(t.tokens);
    } else {
      out.push({ time, open: price, high: price, low: price, close: price, volume: Number(t.tokens) });
    }
  }
  return out;
}
