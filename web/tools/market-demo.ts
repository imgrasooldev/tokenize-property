/**
 * Demo liquidity for team presentations (W4): Alice and Bob trade GPF3 with each other through the
 * real market code, so every trade settles on the local chain and in the ledger.
 *
 * Usage (local chain and PostgreSQL running, from web/):
 *   npm run demo:market -- [rounds=30] [secondsBetween=8]
 *
 * LOCAL DEVELOPMENT ONLY. Since Step 5h every trade is delivered through the outbox and the signing
 * service (Alice's and Bob's wallets are custodial wallets there; `npm run signer:setup`), so the
 * backend services must run: npm run indexer, npm run signer, npm run outbox (backend/).
 */
import { randomInt, randomUUID } from "node:crypto";
import { MIN_TOKENS } from "../src/lib/invest-rules";
import { priceBand } from "../src/lib/market-rules";
import { findProperty } from "../src/lib/properties";
import { db, investorById, type InvestorRow } from "../src/lib/server/db";
import { startFollower, stopFollower } from "../src/lib/server/follower";
import { cancelOrder, cashOf, ordersOf, placeOrder, positionOf, topUp } from "../src/lib/server/market";
import { upsertPersona } from "../src/lib/server/personas";

const SYMBOL = "GPF3";
const rounds = Number(process.argv[2] ?? 30);
const pause = Number(process.argv[3] ?? 8);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 500 || !Number.isInteger(pause) || pause < 0 || pause > 600) {
  throw new Error("usage: market-demo [rounds 1-500] [seconds 0-600]");
}

const out = (line: string) => {
  process.stdout.write(`${line}\n`);
};
const rs = (paisa: bigint) => `Rs ${(Number(paisa) / 100).toFixed(2)}`;

async function persona(name: "ALICE" | "BOB"): Promise<InvestorRow> {
  const row = await investorById(await upsertPersona(name));
  if (row?.kyc_status !== "verified") throw new Error(`${name} is not verified on chain; run chain/flow.py first`);
  return row;
}

async function main(): Promise<void> {
  const p = findProperty(SYMBOL);
  if (!p) throw new Error("unknown property");
  const band = priceBand(p.navPkr);
  const nav = BigInt(p.navPkr) * 100n;
  const people = [await persona("ALICE"), await persona("BOB")];
  // Settles trades in this process too (the website's follower may not be running); one runner at a
  // time across processes, so running it next to the website is safe.
  startFollower();
  for (const who of people) {
    // Start clean: earlier resting orders would otherwise block this run as self-trades.
    for (const o of await ordersOf(who.id)) if (o.status === "open") await cancelOrder(who, o.id);
    if ((await cashOf(who.id)) < 100_000_000n) await topUp(who, 500_000_000n, randomUUID());
  }
  out(`Demo market ${SYMBOL}: ${String(rounds)} rounds, ${String(pause)} s apart. Band ${rs(band.min)}–${rs(band.max)}.`);

  // Random walk within ±6% of NAV, in whole rupees, so the chart moves but stays inside the band.
  let price = nav;
  const lo = (nav * 94n) / 100n;
  const hi = (nav * 106n) / 100n;
  for (let i = 1; i <= rounds; i++) {
    price += BigInt(randomInt(-6, 7)) * 100n;
    price = price < lo ? lo : price > hi ? hi : price;
    const seller = people[randomInt(0, 2)];
    const buyer = people.find((x) => x !== seller);
    if (!seller || !buyer) break;
    const free = (await positionOf(seller, SYMBOL)).freeTokens ?? 0n;
    const tokens = BigInt(randomInt(10, 120));
    if (free < tokens + MIN_TOKENS) {
      out(`#${String(i)} skipped: ${seller.display_name} has no free tokens`);
      continue;
    }
    const sell = await placeOrder(seller, { symbol: SYMBOL, side: "sell", price, tokens, requestId: randomUUID() });
    const buy = await placeOrder(buyer, { symbol: SYMBOL, side: "buy", price, tokens, requestId: randomUUID() });
    if ("error" in sell || "error" in buy) {
      out(`#${String(i)} not placed: ${"error" in sell ? `sell ${sell.error}` : ""} ${"error" in buy ? `buy ${buy.error}` : ""}`);
    } else {
      const { rows } = await (await db()).query<{ status: string; transfer_tx: string | null }>(
        "SELECT status, transfer_tx FROM webdemo.trades WHERE buy_order = $1 ORDER BY created_at DESC LIMIT 1",
        [buy.orderId],
      );
      const t = rows[0];
      out(`#${String(i)} ${seller.display_name} → ${buyer.display_name}: ${tokens.toString()} @ ${rs(price)} — ${t?.status ?? "no trade"} ${t?.transfer_tx?.slice(0, 12) ?? ""}`);
    }
    if (pause > 0 && i < rounds) await new Promise((r) => setTimeout(r, pause * 1000));
  }

  // Leave a few resting orders so the order book is not empty.
  const [alice, bob] = people;
  if (alice && bob) {
    for (const k of [1n, 2n, 3n]) {
      await placeOrder(bob, { symbol: SYMBOL, side: "buy", price: price - k * 300n, tokens: 20n * k, requestId: randomUUID() });
      await placeOrder(alice, { symbol: SYMBOL, side: "sell", price: price + k * 300n, tokens: 25n * k, requestId: randomUUID() });
    }
    out("Left three resting bids (Bob) and three resting asks (Alice) around the last price.");
  }
  // Give the last deliveries time to settle before leaving.
  for (let i = 0; i < 30; i++) {
    const { rows } = await (await db()).query<{ n: string }>("SELECT count(*) AS n FROM webdemo.trades WHERE status = 'settling'");
    if (rows[0]?.n === "0") break;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  await stopFollower();
  await (await db()).end();
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
