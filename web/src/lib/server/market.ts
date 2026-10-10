import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import type { Hex } from "viem";
import { tokenAbi } from "../abis";
import { candles, checkNewOrder, nextMatch, type BookOrder, type Candle, type OrderProblem, type Side } from "../market-rules";
import { findProperty } from "../properties";
import { liveToken } from "./chain";
import { db, investorById, type InvestorRow } from "./db";
import { NotSentError, publicClient, RevertedError, send, waitSuccess } from "./demo-signer";
import { balanceOf, openAccount, postJournal } from "./ledger";
import type { MarketView } from "../market-view";
import { isVerifiedOnChain } from "./onboarding";
import { signerFor } from "./wallets";

/**
 * W4 DEMO secondary market. Secondary trading needs SECP approval and a licensed intermediary;
 * this exists only to show the flow on the local network.
 *
 * Money: each investor has a PKR cash account (demo Raast top-ups). A buy order moves its full
 * cost from cash into a per-order escrow account before it can match; the ledger refuses any
 * overdraft. Tokens: a sell order may offer only tokens that are on chain and not already offered.
 *
 * Settlement (delivery versus payment): a single matcher (PostgreSQL advisory lock) records the
 * trade and the fills, then the seller's custodial wallet transfers the tokens on chain (the token
 * re-checks identity, limits, freeze and pause). Only after the transfer is confirmed does the
 * cash move from the buyer's escrow to the seller. A refused or reverted transfer cancels both
 * orders and releases the escrow; an unknown outcome is held for review and resolved from the
 * transaction receipt.
 */

const MATCHER_LOCK = 586_586_030;
const PKT_OFFSET_S = 5 * 3600;
const ORDER_LOCK = 586_586_020;
const BY = "web-market";
const CLIENT_BANK = "web:bank:client-money";
export const cashAccount = (investorId: string) => `web:investor:${investorId}:cash`;
const escrowAccount = (orderId: string) => `web:order:${orderId}:escrow`;

type Db = pg.ClientBase | pg.Pool;

export interface OrderRow {
  id: string;
  request_id: string;
  investor_id: string;
  symbol: string;
  side: Side;
  price_paisa: string;
  tokens: string;
  filled: string;
  status: "open" | "filled" | "cancelled";
  note: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface TradeRow {
  id: string;
  symbol: string;
  buy_order: string;
  sell_order: string;
  buyer_id: string;
  seller_id: string;
  price_paisa: string;
  tokens: string;
  status: "settling" | "settled" | "failed" | "review";
  transfer_tx: Hex | null;
  note: string | null;
  created_at: Date;
  updated_at: Date;
}

async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

const owed = async (d: Db, code: string) => -(await balanceOf(d, code));

export async function cashOf(investorId: string): Promise<bigint> {
  return owed(await db(), cashAccount(investorId));
}

// ------------------------------------------------------------------ cash top-up (demo Raast)

export async function topUp(investor: InvestorRow, amountPaisa: bigint, requestId: string): Promise<void> {
  await tx(async (c) => {
    const id = randomUUID();
    const bankRef = `RAAST-DEMO-${randomBytes(6).toString("hex").toUpperCase()}`;
    const ins = await c.query(
      `INSERT INTO webdemo.topups (id, request_id, investor_id, amount_paisa, bank_ref) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (request_id) DO NOTHING`,
      [id, requestId, investor.id, amountPaisa.toString(), bankRef],
    );
    if (ins.rowCount !== 1) return; // same request again: already credited once
    await openAccount(c, CLIENT_BANK, "asset", "PKR");
    await openAccount(c, cashAccount(investor.id), "liability", "PKR");
    await postJournal(c, {
      idempotencyKey: `web:topup:${id}`,
      kind: "cash_topup",
      memo: "Raast top-up (demo)",
      externalRef: bankRef,
      createdBy: BY,
      postings: [
        { account: CLIENT_BANK, amount: amountPaisa },
        { account: cashAccount(investor.id), amount: -amountPaisa },
      ],
    });
  });
}

// ------------------------------------------------------------------ orders

export type PlaceError = OrderProblem | "unverified" | "notLive" | "paused" | "chain";

async function inFlight(c: Db, investorId: string, side: "buyer_id" | "seller_id"): Promise<bigint> {
  const col = side === "buyer_id" ? "buyer_id" : "seller_id";
  const { rows } = await c.query<{ n: string | null }>(
    `SELECT sum(tokens) AS n FROM webdemo.trades WHERE ${col} = $1 AND status IN ('settling', 'review')`,
    [investorId],
  );
  return BigInt(rows[0]?.n ?? "0");
}

export async function placeOrder(
  investor: InvestorRow,
  input: { symbol: string; side: Side; price: bigint; tokens: bigint; requestId: string },
): Promise<{ orderId: string } | { error: PlaceError }> {
  const p = findProperty(input.symbol);
  if (p?.status !== "live") return { error: "notLive" };
  if (investor.kyc_status !== "verified" || (await isVerifiedOnChain(investor.wallet_address)) !== true) {
    return { error: "unverified" };
  }
  const live = await liveToken(p.symbol);
  if (!live) return { error: "chain" };
  if (live.paused) return { error: "paused" };

  const result = await tx(async (c): Promise<{ orderId: string } | { error: PlaceError }> => {
    // One order placement at a time per investor, so reservations cannot race each other.
    await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [ORDER_LOCK, investor.id]);
    const again = await c.query<{ id: string }>("SELECT id FROM webdemo.orders WHERE request_id = $1 AND investor_id = $2", [
      input.requestId,
      investor.id,
    ]);
    const existing = again.rows[0]?.id;
    if (existing) return { orderId: existing };

    const balance = await publicClient
      .readContract({ address: live.address, abi: tokenAbi, functionName: "balanceOf", args: [investor.wallet_address] })
      .catch(() => null);
    if (balance === null) return { error: "chain" };
    const { rows: mine } = await c.query<{ side: Side; remaining: string; best: string }>(
      `SELECT side, sum(tokens - filled) AS remaining,
              CASE WHEN side = 'buy' THEN max(price_paisa) ELSE min(price_paisa) END AS best
       FROM webdemo.orders WHERE investor_id = $1 AND symbol = $2 AND status = 'open' GROUP BY side`,
      [investor.id, p.symbol],
    );
    const openSell = mine.find((r) => r.side === "sell");
    const openBuy = mine.find((r) => r.side === "buy");
    const opposite = input.side === "buy" ? openSell : openBuy;
    const problem = checkNewOrder({
      side: input.side,
      tokens: input.tokens,
      pricePaisa: input.price,
      navPkr: p.navPkr,
      freeTokens: balance - BigInt(openSell?.remaining ?? "0") - (await inFlight(c, investor.id, "seller_id")),
      committedHolding: balance + BigInt(openBuy?.remaining ?? "0") + (await inFlight(c, investor.id, "buyer_id")),
      cashPaisa: await owed(c, cashAccount(investor.id)),
      ownOppositeBest: opposite ? BigInt(opposite.best) : null,
    });
    if (problem) return { error: problem };

    const id = randomUUID();
    await c.query(
      `INSERT INTO webdemo.orders (id, request_id, investor_id, symbol, side, price_paisa, tokens, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')`,
      [id, input.requestId, investor.id, p.symbol, input.side, input.price.toString(), input.tokens.toString()],
    );
    if (input.side === "buy") {
      const cost = input.price * input.tokens;
      await openAccount(c, cashAccount(investor.id), "liability", "PKR");
      await openAccount(c, escrowAccount(id), "liability", "PKR");
      await postJournal(c, {
        idempotencyKey: `web:order:${id}:reserve`,
        kind: "order_reserve",
        memo: `Buy ${input.tokens.toString()} ${p.symbol} (demo market)`,
        createdBy: BY,
        postings: [
          { account: cashAccount(investor.id), amount: cost },
          { account: escrowAccount(id), amount: -cost },
        ],
      });
    }
    return { orderId: id };
  });

  if ("orderId" in result) await runMatcher(p.symbol);
  return result;
}

/** Escrow of a buy order that is free to return: its balance minus trades still awaiting review. */
async function releasable(c: Db, orderId: string): Promise<bigint> {
  const { rows } = await c.query<{ n: string | null }>(
    "SELECT sum(price_paisa * tokens) AS n FROM webdemo.trades WHERE buy_order = $1 AND status = 'review'",
    [orderId],
  );
  return (await owed(c, escrowAccount(orderId))) - BigInt(rows[0]?.n ?? "0");
}

async function releaseEscrow(c: Db, order: Pick<OrderRow, "id" | "investor_id">, key: string): Promise<void> {
  const amount = await releasable(c, order.id);
  if (amount <= 0n) return;
  await postJournal(c, {
    idempotencyKey: key,
    kind: "order_release",
    memo: "Unused buy-order escrow returned to cash",
    createdBy: BY,
    postings: [
      { account: escrowAccount(order.id), amount },
      { account: cashAccount(order.investor_id), amount: -amount },
    ],
  });
}

/** Runs fn while holding the matcher lock (waits for it), so no trade is in flight meanwhile. */
async function withMatcherLock<T>(fn: () => Promise<T>): Promise<T> {
  const client = await (await db()).connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MATCHER_LOCK]);
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MATCHER_LOCK]);
    }
  } finally {
    client.release();
  }
}

export async function cancelOrder(investor: InvestorRow, orderId: string): Promise<boolean> {
  return withMatcherLock(() =>
    tx(async (c) => {
      const { rows } = await c.query<OrderRow>(
        `UPDATE webdemo.orders SET status = 'cancelled', note = 'cancelled by investor', updated_at = clock_timestamp()
         WHERE id = $1 AND investor_id = $2 AND status = 'open' RETURNING *`,
        [orderId, investor.id],
      );
      const order = rows[0];
      if (!order) return false;
      if (order.side === "buy") await releaseEscrow(c, order, `web:order:${order.id}:release`);
      return true;
    }),
  );
}

// ------------------------------------------------------------------ matching and settlement

async function best(c: Db, symbol: string, side: Side): Promise<(BookOrder & { row: OrderRow }) | undefined> {
  const { rows } = await c.query<OrderRow>(
    `SELECT * FROM webdemo.orders WHERE symbol = $1 AND side = $2 AND status = 'open' AND filled < tokens
     ORDER BY price_paisa ${side === "buy" ? "DESC" : "ASC"}, created_at, id LIMIT 1`,
    [symbol, side],
  );
  const r = rows[0];
  if (!r) return undefined;
  return {
    id: r.id,
    investorId: r.investor_id,
    pricePaisa: BigInt(r.price_paisa),
    remaining: BigInt(r.tokens) - BigInt(r.filled),
    createdAt: r.created_at,
    row: r,
  };
}

async function crossing(symbol: string): Promise<boolean> {
  const pool = await db();
  return nextMatch(await best(pool, symbol, "buy"), await best(pool, symbol, "sell")) !== null;
}

/**
 * Matches until the book no longer crosses. Only one matcher runs at a time across all server
 * processes; a caller that cannot get the lock leaves the work to the holder, which re-checks the
 * book after releasing it, so no crossing order is left behind.
 */
export async function runMatcher(symbol: string): Promise<void> {
  const client = await (await db()).connect();
  try {
    // Bounded: if a crossing pair cannot be recorded (data changed underneath), stop rather than spin.
    for (let round = 0; round < 5; round++) {
      const { rows } = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [MATCHER_LOCK]);
      if (!rows[0]?.ok) return;
      try {
        await resolveReviews();
        let guard = 0;
        while (guard++ < 500 && (await matchOnce(symbol))) {
          // keep matching
        }
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [MATCHER_LOCK]);
      }
      if (!(await crossing(symbol))) return;
    }
  } finally {
    client.release();
  }
}

async function matchOnce(symbol: string): Promise<boolean> {
  const pool = await db();
  const bid = await best(pool, symbol, "buy");
  const ask = await best(pool, symbol, "sell");
  const m = nextMatch(bid, ask);
  if (!m || !bid || !ask) return false;

  const tradeId = randomUUID();
  const recorded = await tx(async (c) => {
    const fill = async (o: OrderRow) =>
      c.query(
        `UPDATE webdemo.orders SET filled = filled + $2,
           status = CASE WHEN filled + $2 = tokens THEN 'filled' ELSE 'open' END, updated_at = clock_timestamp()
         WHERE id = $1 AND status = 'open' AND tokens - filled >= $2`,
        [o.id, m.tokens.toString()],
      );
    if ((await fill(bid.row)).rowCount !== 1 || (await fill(ask.row)).rowCount !== 1) throw new Error("order changed during matching");
    await c.query(
      `INSERT INTO webdemo.trades (id, symbol, buy_order, sell_order, buyer_id, seller_id, price_paisa, tokens, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'settling')`,
      [tradeId, symbol, bid.id, ask.id, bid.investorId, ask.investorId, m.pricePaisa.toString(), m.tokens.toString()],
    );
    return true;
  }).catch(() => false);
  if (!recorded) return false;

  const [buyer, seller, live] = await Promise.all([investorById(bid.investorId), investorById(ask.investorId), liveToken(symbol)]);
  if (!buyer || !seller || !live) {
    await failTrade(tradeId, "investor or token unavailable; nothing was sent");
    return true;
  }
  let signer: ReturnType<typeof signerFor>;
  try {
    signer = signerFor(seller);
  } catch {
    await failTrade(tradeId, "seller's custodial key unavailable; nothing was sent");
    return true;
  }
  let hash: Hex;
  try {
    hash = await send(signer, {
      address: live.address,
      abi: tokenAbi,
      functionName: "transfer",
      args: [buyer.wallet_address, m.tokens],
    });
  } catch (e) {
    if (e instanceof NotSentError) await failTrade(tradeId, "transfer refused by on-chain compliance before sending");
    else await reviewTrade(tradeId, null, "transfer broadcast failed; outcome unknown");
    return true;
  }
  try {
    await waitSuccess(hash);
  } catch (e) {
    if (e instanceof RevertedError) await failTrade(tradeId, `transfer reverted (${hash})`);
    else await reviewTrade(tradeId, hash, "transfer not confirmed in time");
    return true;
  }
  await settleTrade(tradeId, hash);
  return true;
}

async function settleTrade(tradeId: string, hash: Hex): Promise<void> {
  await tx(async (c) => {
    const { rows } = await c.query<TradeRow>(
      `UPDATE webdemo.trades SET status = 'settled', transfer_tx = $2, note = NULL, updated_at = clock_timestamp()
       WHERE id = $1 AND status IN ('settling', 'review') RETURNING *`,
      [tradeId, hash],
    );
    const t = rows[0];
    if (!t) return;
    const cost = BigInt(t.price_paisa) * BigInt(t.tokens);
    await openAccount(c, cashAccount(t.seller_id), "liability", "PKR");
    await postJournal(c, {
      idempotencyKey: `web:trade:${t.id}:settle`,
      kind: "trade_settled",
      memo: `${t.tokens} ${t.symbol} delivered on chain (demo market)`,
      externalRef: hash,
      createdBy: BY,
      postings: [
        { account: escrowAccount(t.buy_order), amount: cost },
        { account: cashAccount(t.seller_id), amount: -cost },
      ],
    });
    // A buy order that is complete returns any escrow left over from buying below its limit.
    const { rows: done } = await c.query<OrderRow>("SELECT * FROM webdemo.orders WHERE id = $1 AND status = 'filled'", [t.buy_order]);
    const order = done[0];
    if (order) await releaseEscrow(c, order, `web:order:${order.id}:release`);
  });
}

/** The transfer can never happen: undo the fills, cancel both orders and return the buyer's escrow. */
async function failTrade(tradeId: string, reason: string): Promise<void> {
  await tx(async (c) => {
    const { rows } = await c.query<TradeRow>(
      `UPDATE webdemo.trades SET status = 'failed', note = $2, updated_at = clock_timestamp()
       WHERE id = $1 AND status IN ('settling', 'review') RETURNING *`,
      [tradeId, reason.slice(0, 300)],
    );
    const t = rows[0];
    if (!t) return;
    for (const id of [t.buy_order, t.sell_order]) {
      await c.query(
        `UPDATE webdemo.orders SET filled = filled - $2, status = 'cancelled', note = $3, updated_at = clock_timestamp()
         WHERE id = $1`,
        [id, t.tokens, `cancelled: matched trade refused on chain`],
      );
    }
    await releaseEscrow(c, { id: t.buy_order, investor_id: t.buyer_id }, `web:trade:${t.id}:release`);
  });
}

async function reviewTrade(tradeId: string, hash: Hex | null, reason: string): Promise<void> {
  await (await db()).query(
    `UPDATE webdemo.trades SET status = 'review', transfer_tx = $2, note = $3, updated_at = clock_timestamp()
     WHERE id = $1 AND status = 'settling'`,
    [tradeId, hash, reason.slice(0, 300)],
  );
}

/**
 * Resolves trades held for review from their transaction receipt: success settles, revert fails.
 * Without a transaction hash the outcome stays with operations. Also picks up trades left in
 * "settling" by a crashed process (older than two minutes).
 */
async function resolveReviews(): Promise<void> {
  const pool = await db();
  await pool.query(
    `UPDATE webdemo.trades SET status = 'review', note = 'interrupted; waiting for reconciliation', updated_at = clock_timestamp()
     WHERE status = 'settling' AND updated_at < now() - interval '2 minutes'`,
  );
  const { rows } = await pool.query<TradeRow>("SELECT * FROM webdemo.trades WHERE status = 'review' AND transfer_tx IS NOT NULL");
  for (const t of rows) {
    if (!t.transfer_tx) continue;
    const receipt = await publicClient.getTransactionReceipt({ hash: t.transfer_tx }).catch(() => null);
    if (receipt?.status === "success") await settleTrade(t.id, t.transfer_tx);
    else if (receipt?.status === "reverted") await failTrade(t.id, `transfer reverted (${t.transfer_tx})`);
  }
}

// ------------------------------------------------------------------ read models

export interface BookLevel {
  pricePaisa: bigint;
  tokens: bigint;
  orders: number;
}

export interface MarketSnapshot {
  version: string;
  bids: BookLevel[];
  asks: BookLevel[];
  trades: { id: string; at: Date; pricePaisa: bigint; tokens: bigint; tx: Hex | null }[];
  candles: Candle[];
  last: bigint | null;
  volume24h: bigint;
}

export async function marketSnapshot(symbol: string): Promise<MarketSnapshot> {
  const pool = await db();
  const [ver, book, recent, series] = await Promise.all([
    pool.query<{ v: string }>(
      `SELECT concat((SELECT coalesce(max(updated_at)::text, '') FROM webdemo.orders WHERE symbol = $1), '|',
                     (SELECT coalesce(max(updated_at)::text, '') FROM webdemo.trades WHERE symbol = $1)) AS v`,
      [symbol],
    ),
    pool.query<{ side: Side; price_paisa: string; tokens: string; n: string }>(
      `SELECT side, price_paisa, sum(tokens - filled) AS tokens, count(*) AS n FROM webdemo.orders
       WHERE symbol = $1 AND status = 'open' AND filled < tokens GROUP BY side, price_paisa`,
      [symbol],
    ),
    pool.query<{ id: string; created_at: Date; price_paisa: string; tokens: string; transfer_tx: Hex | null }>(
      `SELECT id, created_at, price_paisa, tokens, transfer_tx FROM webdemo.trades
       WHERE symbol = $1 AND status = 'settled' ORDER BY created_at DESC LIMIT 30`,
      [symbol],
    ),
    pool.query<{ created_at: Date; price_paisa: string; tokens: string }>(
      `SELECT created_at, price_paisa, tokens FROM webdemo.trades
       WHERE symbol = $1 AND status = 'settled' AND created_at > now() - interval '24 hours' ORDER BY created_at`,
      [symbol],
    ),
  ]);
  const level = (r: { price_paisa: string; tokens: string; n: string }): BookLevel => ({
    pricePaisa: BigInt(r.price_paisa),
    tokens: BigInt(r.tokens),
    orders: Number(r.n),
  });
  const bids = book.rows.filter((r) => r.side === "buy").map(level).sort((a, b) => (b.pricePaisa > a.pricePaisa ? 1 : -1)).slice(0, 10);
  const asks = book.rows.filter((r) => r.side === "sell").map(level).sort((a, b) => (a.pricePaisa > b.pricePaisa ? 1 : -1)).slice(0, 10);
  const series24 = series.rows.map((r) => ({ at: r.created_at, pricePaisa: BigInt(r.price_paisa), tokens: BigInt(r.tokens) }));
  return {
    version: ver.rows[0]?.v ?? "",
    bids,
    asks,
    trades: recent.rows.map((r) => ({ id: r.id, at: r.created_at, pricePaisa: BigInt(r.price_paisa), tokens: BigInt(r.tokens), tx: r.transfer_tx })),
    candles: candles(series24),
    last: recent.rows[0] ? BigInt(recent.rows[0].price_paisa) : null,
    volume24h: series24.reduce((a, t) => a + t.tokens, 0n),
  };
}

/** Cash available and tokens not yet offered, for the order form. */
export async function positionOf(investor: InvestorRow, symbol: string): Promise<{ cashPaisa: bigint; freeTokens: bigint | null }> {
  const pool = await db();
  const live = await liveToken(symbol);
  const balance = live
    ? await publicClient
        .readContract({ address: live.address, abi: tokenAbi, functionName: "balanceOf", args: [investor.wallet_address] })
        .catch(() => null)
    : null;
  const { rows } = await pool.query<{ n: string | null }>(
    "SELECT sum(tokens - filled) AS n FROM webdemo.orders WHERE investor_id = $1 AND symbol = $2 AND side = 'sell' AND status = 'open'",
    [investor.id, symbol],
  );
  const offered = BigInt(rows[0]?.n ?? "0") + (await inFlight(pool, investor.id, "seller_id"));
  return { cashPaisa: await owed(pool, cashAccount(investor.id)), freeTokens: balance === null ? null : balance - offered };
}

/** Browser-safe form of a snapshot: rupees as numbers, no identities. */
export function toView(s: MarketSnapshot): MarketView {
  const rs = (p: bigint) => Number(p) / 100;
  return {
    version: s.version,
    bids: s.bids.map((l) => ({ price: rs(l.pricePaisa), tokens: Number(l.tokens), orders: l.orders })),
    asks: s.asks.map((l) => ({ price: rs(l.pricePaisa), tokens: Number(l.tokens), orders: l.orders })),
    trades: s.trades.map((t) => ({ id: t.id, at: t.at.toISOString(), price: rs(t.pricePaisa), tokens: Number(t.tokens), tx: t.tx })),
    // The chart library shows UTC; shift to Pakistan time (UTC+5, no daylight saving) for display.
    candles: s.candles.map((c) => ({ ...c, time: c.time + PKT_OFFSET_S })),
    last: s.last === null ? null : rs(s.last),
    volume24h: Number(s.volume24h),
  };
}

export async function ordersOf(investorId: string): Promise<OrderRow[]> {
  const { rows } = await (await db()).query<OrderRow>(
    "SELECT * FROM webdemo.orders WHERE investor_id = $1 ORDER BY created_at DESC LIMIT 30",
    [investorId],
  );
  return rows;
}

export async function tradesOf(investorId: string): Promise<TradeRow[]> {
  const { rows } = await (await db()).query<TradeRow>(
    "SELECT * FROM webdemo.trades WHERE buyer_id = $1 OR seller_id = $1 ORDER BY created_at DESC LIMIT 30",
    [investorId],
  );
  return rows;
}

/** Sum of escrow still held for this investor's buy orders (should equal open buy reservations). */
export async function escrowOf(investorId: string): Promise<bigint> {
  const { rows } = await (await db()).query<{ n: string | null }>(
    `SELECT -sum(b.balance) AS n FROM ledger.balances b
     JOIN webdemo.orders o ON b.code = 'web:order:' || o.id || ':escrow' WHERE o.investor_id = $1`,
    [investorId],
  );
  return BigInt(rows[0]?.n ?? "0");
}
