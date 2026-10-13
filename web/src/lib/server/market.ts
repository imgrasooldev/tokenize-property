import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import type { Address, Hex } from "viem";
import { candles, checkNewOrder, nextMatch, type BookOrder, type Candle, type OrderProblem, type Side } from "../market-rules";
import { findProperty } from "../properties";
import { txBlock, txOutcome } from "./chain";
import { db, investorById, tx, type InvestorRow } from "./db";
import { balanceOf, openAccount, postJournal } from "./ledger";
import type { MarketView } from "../market-view";
import { commandStates, enqueue } from "./outbox";
import { holdingOf, indexStatus, liveToken, registeredOnChain, transfersInTx } from "./readmodel";

/**
 * W4 DEMO secondary market. Secondary trading needs SECP approval and a licensed intermediary;
 * this exists only to show the flow on the local network.
 *
 * Money: each investor has a PKR cash account (demo Raast top-ups). A buy order moves its full
 * cost from cash into a per-order escrow account before it can match; the ledger refuses any
 * overdraft. Tokens: a sell order may offer only tokens that are on chain and not already offered.
 *
 * Settlement (delivery versus payment), Step 5h (ADR 0010): a single matcher (PostgreSQL advisory
 * lock) records the trade, the fills and an outbox `token.transfer` command in ONE transaction. The
 * outbox worker has the signing service sign the transfer with the seller's custodial wallet (the
 * service holds the key; the website never does) only while the buyer's escrow holds the trade's
 * cost; the token re-checks identity, limits, freeze and pause. Only when the read model shows the
 * transfer does the cash move from the buyer's escrow to the seller (settlement follower). A
 * refused or reverted transfer cancels both orders and releases the escrow; anything unknown is
 * held for review.
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
  transfer_nonce: number | null;
  command_id: string | null;
  note: string | null;
  created_at: Date;
  updated_at: Date;
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

async function inFlight(c: Db, investorId: string, symbol: string, side: "buyer_id" | "seller_id"): Promise<bigint> {
  const col = side === "buyer_id" ? "buyer_id" : "seller_id";
  const { rows } = await c.query<{ n: string | null }>(
    `SELECT sum(tokens) AS n FROM webdemo.trades WHERE ${col} = $1 AND symbol = $2 AND status IN ('settling', 'review')`,
    [investorId, symbol],
  );
  return BigInt(rows[0]?.n ?? "0");
}

export async function placeOrder(
  investor: InvestorRow,
  input: { symbol: string; side: Side; price: bigint; tokens: bigint; requestId: string },
): Promise<{ orderId: string } | { error: PlaceError }> {
  const p = findProperty(input.symbol);
  if (p?.status !== "live") return { error: "notLive" };
  if (investor.kyc_status !== "verified" || (await registeredOnChain(investor.wallet_address)) !== true) {
    return { error: "unverified" };
  }
  const live = await liveToken(p.symbol, true);
  if (!live) return { error: "chain" };
  if (live.paused) return { error: "paused" };
  // Read model balance. A trade or subscription stays "in flight" until the read model shows its
  // transfer or mint (the follower settles only then), so read model + in flight never misses one.
  const balance = await holdingOf(investor.wallet_address);
  if (balance === null) return { error: "chain" };

  const result = await tx(async (c): Promise<{ orderId: string } | { error: PlaceError }> => {
    // One order placement at a time per investor, so reservations cannot race each other.
    await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [ORDER_LOCK, investor.id]);
    const again = await c.query<{ id: string }>("SELECT id FROM webdemo.orders WHERE request_id = $1 AND investor_id = $2", [
      input.requestId,
      investor.id,
    ]);
    const existing = again.rows[0]?.id;
    if (existing) return { orderId: existing };

    const { rows: mine } = await c.query<{ side: Side; remaining: string; best: string }>(
      `SELECT side, sum(tokens - filled) AS remaining,
              CASE WHEN side = 'buy' THEN max(price_paisa) ELSE min(price_paisa) END AS best
       FROM webdemo.orders WHERE investor_id = $1 AND symbol = $2 AND status = 'open' GROUP BY side`,
      [investor.id, p.symbol],
    );
    const openSell = mine.find((r) => r.side === "sell");
    const openBuy = mine.find((r) => r.side === "buy");
    const opposite = input.side === "buy" ? openSell : openBuy;
    const sellingNow = await inFlight(c, investor.id, p.symbol, "seller_id");
    const buyingNow = await inFlight(c, investor.id, p.symbol, "buyer_id");
    const { rows: subs } = await c.query<{ n: string }>(
      "SELECT coalesce(sum(tokens), 0) AS n FROM webdemo.subscriptions WHERE investor_id = $1 AND symbol = $2 AND status IN ('paid', 'minting', 'review')",
      [investor.id, p.symbol],
    );
    const problem = checkNewOrder({
      side: input.side,
      tokens: input.tokens,
      pricePaisa: input.price,
      navPkr: p.navPkr,
      freeTokens: balance - BigInt(openSell?.remaining ?? "0") - sellingNow,
      committedHolding: balance + BigInt(openBuy?.remaining ?? "0") + buyingNow + BigInt(subs[0]?.n ?? "0"),
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

/**
 * Escrow of a buy order that is free to return: its balance minus every trade not settled yet.
 * Since Step 5h trades settle asynchronously, so a trade still "settling" keeps its cost in escrow:
 * the signing service delivers only while the escrow holds it (DvP), and it must not be released
 * under a transfer that may still be mined.
 */
async function releasable(c: Db, orderId: string): Promise<bigint> {
  const { rows } = await c.query<{ n: string | null }>(
    "SELECT sum(price_paisa * tokens) AS n FROM webdemo.trades WHERE buy_order = $1 AND status IN ('settling', 'review')",
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

/**
 * Runs fn while holding the matcher lock, so no trade is in flight meanwhile. Polls with
 * pg_try_advisory_lock and holds a database connection only while it owns the lock, so waiting
 * callers never starve the pool. Gives up after `maxWaitMs`.
 */
async function withMatcherLock<T>(fn: () => Promise<T>, maxWaitMs = 60_000): Promise<T> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const client = await (await db()).connect();
    let owned = false;
    try {
      const { rows } = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [MATCHER_LOCK]);
      owned = rows[0]?.ok === true;
      if (owned) return await fn();
    } finally {
      if (owned) await client.query("SELECT pg_advisory_unlock($1)", [MATCHER_LOCK]);
      client.release();
    }
    if (Date.now() > deadline) throw new Error("market is busy; try again");
    await new Promise((r) => setTimeout(r, 200));
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

/**
 * Records one match: the fills, the trade and its outbox `token.transfer` command in ONE
 * transaction (O-1). Nothing is sent here; the outbox worker and the signing service do that, and
 * the settlement follower moves the cash once the read model shows the transfer.
 */
async function matchOnce(symbol: string): Promise<boolean> {
  const pool = await db();
  const bid = await best(pool, symbol, "buy");
  const ask = await best(pool, symbol, "sell");
  const m = nextMatch(bid, ask);
  if (!m || !bid || !ask) return false;

  const [buyer, seller, live] = await Promise.all([investorById(bid.investorId), investorById(ask.investorId), liveToken(symbol, true)]);
  // Nothing recorded and nobody at fault: keep both orders, stop matching for now.
  if (!buyer || !seller || !live) return false;
  const custodial = await pool.query("SELECT 1 FROM signer.custodial_wallets WHERE address = $1", [seller.wallet_address.toLowerCase()]);
  if (custodial.rowCount !== 1) {
    // The signing service does not hold the seller's key, so this offer can never be delivered.
    await pool.query(
      "UPDATE webdemo.orders SET status = 'cancelled', note = 'cancelled: seller wallet not in custody; nothing was sent', updated_at = clock_timestamp() WHERE id = $1 AND status = 'open'",
      [ask.id],
    );
    return true;
  }

  const tradeId = randomUUID();
  return tx(async (c) => {
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
    const command = await enqueue(
      c,
      `web:trade:${tradeId}:transfer`,
      "token.transfer",
      {
        token: live.address,
        from: seller.wallet_address.toLowerCase(),
        to: buyer.wallet_address.toLowerCase(),
        amount: m.tokens.toString(),
        trade: tradeId,
        escrowAccount: escrowAccount(bid.id),
        costPaisa: (m.pricePaisa * m.tokens).toString(),
      },
      `web:trade:${tradeId}`,
    );
    await c.query("UPDATE webdemo.trades SET command_id = $2 WHERE id = $1", [tradeId, command.toString()]);
    return true;
  }).catch(() => false);
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

/**
 * The transfer can never happen: undo the fills, mark the trade failed, cancel the orders named
 * and return the buyer's escrow if the buy order is cancelled. Orders not cancelled stay open.
 */
async function undoTrade(tradeId: string, reason: string, cancel: { buy: boolean; sell: boolean }): Promise<void> {
  await tx(async (c) => {
    const { rows } = await c.query<TradeRow>(
      `UPDATE webdemo.trades SET status = 'failed', note = $2, updated_at = clock_timestamp()
       WHERE id = $1 AND status IN ('settling', 'review') RETURNING *`,
      [tradeId, reason.slice(0, 300)],
    );
    const t = rows[0];
    if (!t) return;
    const orders: [string, boolean][] = [
      [t.buy_order, cancel.buy],
      [t.sell_order, cancel.sell],
    ];
    for (const [id, stop] of orders) {
      await c.query(
        `UPDATE webdemo.orders SET filled = filled - $2,
           status = CASE WHEN $3 THEN 'cancelled' WHEN status = 'filled' THEN 'open' ELSE status END,
           note = CASE WHEN $3 THEN $4 ELSE note END, updated_at = clock_timestamp()
         WHERE id = $1`,
        [id, t.tokens, stop, "cancelled: matched trade refused on chain"],
      );
    }
    if (cancel.buy) await releaseEscrow(c, { id: t.buy_order, investor_id: t.buyer_id }, `web:trade:${t.id}:release`);
  });
}

async function setTradeStatus(tradeId: string, status: "settling" | "review", reason: string | null): Promise<void> {
  await (await db()).query(
    `UPDATE webdemo.trades SET status = $2, note = $3, updated_at = clock_timestamp()
     WHERE id = $1 AND status IN ('settling', 'review') AND (status <> $2 OR note IS DISTINCT FROM $3)`,
    [tradeId, status, reason?.slice(0, 300) ?? null],
  );
}

type OpenTrade = TradeRow & { seller_wallet: Address; buyer_wallet: Address; stale: boolean };

let lastSlowTradePass = 0;

/**
 * One pass over every unfinished trade (called by the settlement follower; ADR 0010 §2). Runs
 * under the matcher lock, like cancels, so fills and escrow never change underneath it; if the
 * matcher is busy it does nothing this time.
 *   confirmed + read model shows seller -> buyer of this amount in that transaction: settle (DvP);
 *   failed (final) + no recorded transaction, or the chain proves it reverted or was dropped: undo;
 *   review, or anything that does not match: review (operations).
 */
export async function settleTrades(): Promise<void> {
  const pool = await db();
  const client = await pool.connect();
  try {
    const { rows: lock } = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [MATCHER_LOCK]);
    if (!lock[0]?.ok) return;
    try {
      const { rows } = await pool.query<OpenTrade>(
        `SELECT t.*, s.wallet_address AS seller_wallet, b.wallet_address AS buyer_wallet, t.updated_at < now() - interval '2 minutes' AS stale
         FROM webdemo.trades t JOIN webdemo.investors s ON s.id = t.seller_id JOIN webdemo.investors b ON b.id = t.buyer_id
         WHERE t.status IN ('settling', 'review') ORDER BY t.created_at LIMIT 200`,
      );
      if (rows.length === 0) return;
      const states = await commandStates(pool, rows.map((r) => r.command_id));
      const cursor = (await indexStatus())?.block ?? null;
      // Trades in review and pre-5h trades need chain reads and rarely change: every 30 s only.
      const slow = Date.now() - lastSlowTradePass >= 30_000;
      if (slow) lastSlowTradePass = Date.now();
      for (const t of rows) {
        const cmd = t.command_id ? states.get(t.command_id) : undefined;
        if ((t.status === "review" || !t.command_id) && !slow && !(cmd && cmd.status !== "review" && cmd.status !== "failed")) continue;
        if (!t.command_id) {
          await settleLegacyTrade(t);
          continue;
        }
        if (!cmd) continue;
        const delivered = cmd.txHash ? await transfersInTx(t.seller_wallet, cmd.txHash) : [];
        if (delivered === undefined) continue; // read model unavailable: decide nothing
        const match = delivered.some((d) => d.to === t.buyer_wallet.toLowerCase() && d.amount === BigInt(t.tokens));
        if (match && cmd.txHash) {
          await settleTrade(t.id, cmd.txHash);
          continue;
        }
        switch (cmd.status) {
          case "confirmed": {
            if (delivered.length > 0) {
              await setTradeStatus(t.id, "review", "the transfer on chain does not match the trade");
              break;
            }
            // Not indexed yet, unless the indexer is already past the transaction's block.
            const block = cmd.txHash ? await txBlock(cmd.txHash) : null;
            if (block !== null && cursor !== null && cursor >= block) await setTradeStatus(t.id, "review", "confirmed transfer missing from the read model");
            break;
          }
          case "failed": {
            if (!cmd.txHash || !cmd.txFrom || cmd.txNonce === null) {
              // Refused before anything was sent (policy, compliance, simulation): it can never happen.
              await undoTrade(t.id, `transfer refused before sending: ${cmd.lastError ?? "refused"}`, { buy: true, sell: true });
              break;
            }
            const outcome = await txOutcome(cmd.txHash, cmd.txFrom, cmd.txNonce);
            if (outcome === "reverted" || outcome === "dropped") await undoTrade(t.id, `transfer ${outcome} (${cmd.txHash})`, { buy: true, sell: true });
            else if (outcome !== "success") await setTradeStatus(t.id, "review", `transfer command failed; transaction ${outcome}`);
            break; // success: wait for the read model
          }
          case "review":
            await setTradeStatus(t.id, "review", `held for operations: ${cmd.lastError ?? "outcome unknown"}`);
            break;
          default:
            if (t.status === "review") await setTradeStatus(t.id, "settling", null);
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MATCHER_LOCK]);
    }
  } finally {
    client.release();
  }
}

/**
 * Trades from before Step 5h (sent by the old demo signer, no outbox command): resolved from the
 * read model and the chain exactly as before, and never sent again.
 */
async function settleLegacyTrade(t: OpenTrade): Promise<void> {
  if (t.status === "settling" && !t.stale) return;
  if (!t.transfer_tx || t.transfer_nonce === null) {
    await undoTrade(t.id, "no transfer was ever sent", { buy: true, sell: true });
    return;
  }
  const delivered = await transfersInTx(t.seller_wallet, t.transfer_tx);
  if (delivered?.some((d) => d.to === t.buyer_wallet.toLowerCase() && d.amount === BigInt(t.tokens))) {
    await settleTrade(t.id, t.transfer_tx);
    return;
  }
  const outcome = await txOutcome(t.transfer_tx, t.seller_wallet, BigInt(t.transfer_nonce));
  if (outcome === "reverted" || outcome === "dropped") await undoTrade(t.id, `transfer ${outcome} (${t.transfer_tx})`, { buy: true, sell: true });
  else if (t.status === "settling") await setTradeStatus(t.id, "review", "interrupted; waiting for reconciliation");
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

const SNAPSHOT_TTL_MS = 700;
const snapshots = new Map<string, { at: number; value: Promise<MarketSnapshot> }>();

/**
 * The public market view. All live-feed connections share one snapshot per symbol (at most one
 * set of queries every 0.7 s), so viewers cannot multiply the database load.
 */
export async function marketSnapshot(symbol: string): Promise<MarketSnapshot> {
  const hit = snapshots.get(symbol);
  if (hit && Date.now() - hit.at < SNAPSHOT_TTL_MS) return hit.value;
  const value = readSnapshot(symbol);
  snapshots.set(symbol, { at: Date.now(), value });
  value.catch(() => snapshots.delete(symbol));
  return value;
}

/** Throttled matcher run for page loads: at most once every 5 s per process, never blocking. */
let lastPageMatch = 0;
export function nudgeMatcher(symbol: string): void {
  if (Date.now() - lastPageMatch < 5_000) return;
  lastPageMatch = Date.now();
  void runMatcher(symbol).catch(() => undefined);
}

async function readSnapshot(symbol: string): Promise<MarketSnapshot> {
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
  const balance = (await liveToken(symbol)) ? await holdingOf(investor.wallet_address) : null;
  const { rows } = await pool.query<{ n: string | null }>(
    "SELECT sum(tokens - filled) AS n FROM webdemo.orders WHERE investor_id = $1 AND symbol = $2 AND side = 'sell' AND status = 'open'",
    [investor.id, symbol],
  );
  const offered = BigInt(rows[0]?.n ?? "0") + (await inFlight(pool, investor.id, symbol, "seller_id"));
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

/**
 * Checks every buy order's escrow in the ledger against the order book: an open order holds its
 * reservation minus what its settled trades cost; a finished order holds only trades under review.
 */
export async function escrowMatches(investorId: string): Promise<boolean> {
  const { rows } = await (await db()).query<{ bad: string }>(
    `WITH o AS (
       SELECT o.id, o.status, o.price_paisa * o.tokens AS reserved,
              coalesce((SELECT sum(t.price_paisa * t.tokens) FROM webdemo.trades t WHERE t.buy_order = o.id AND t.status = 'settled'), 0) AS spent,
              coalesce((SELECT sum(t.price_paisa * t.tokens) FROM webdemo.trades t WHERE t.buy_order = o.id AND t.status IN ('settling', 'review')), 0) AS pending,
              coalesce((SELECT -b.balance FROM ledger.balances b WHERE b.code = 'web:order:' || o.id || ':escrow'), 0) AS held,
              EXISTS (SELECT 1 FROM ledger.journal j WHERE j.idempotency_key = 'web:order:' || o.id || ':release') AS released
       FROM webdemo.orders o WHERE o.investor_id = $1 AND o.side = 'buy')
     SELECT count(*) AS bad FROM o
     -- Until its leftover is released an order holds reserved - spent; afterwards only trades still pending.
     WHERE held <> CASE WHEN status = 'open' OR (status = 'filled' AND NOT released) THEN reserved - spent ELSE pending END`,
    [investorId],
  );
  return rows[0]?.bad === "0";
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
