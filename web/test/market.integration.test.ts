import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { latestDeployment } from "../src/lib/server/chain";
import { db, type InvestorRow } from "../src/lib/server/db";
import { stopFollower } from "../src/lib/server/follower";
import { placeOrder as invest, subscriptionById } from "../src/lib/server/invest";
import { chainProblems } from "../src/lib/server/ledger";
import { cancelOrder, cashOf, escrowMatches, escrowOf, placeOrder, runMatcher, topUp } from "../src/lib/server/market";
import { asAdmin, chainBalance, onboardInvestor, signerRequestFor, trusteeCosign, until } from "./helpers";
import { chainUp, prepare, start, type Stack } from "./stack";

/**
 * W4 demo market with delivery through the outbox and the signing service (Step 5h, ADR 0010), on
 * the real local chain and the TEST database. Two fresh investors are onboarded per run; the seller
 * gets tokens through the invest flow. Skipped without a chain (CI).
 */
const up = await chainUp();
if (up) prepare();
const RS = 100n;

let seller: InvestorRow;
let buyer: InvestorRow;
let stack: Stack;

async function order(who: InvestorRow, side: "buy" | "sell", rupees: bigint, tokens: bigint) {
  return placeOrder(who, { symbol: "GPF3", side, price: rupees * RS, tokens, requestId: randomUUID() });
}

function id(r: Awaited<ReturnType<typeof placeOrder>>): string {
  if ("error" in r) throw new Error(`order refused: ${r.error}`);
  return r.orderId;
}

const tradesOpen = async () => (await asAdmin<{ n: string }>("SELECT count(*) AS n FROM webdemo.trades WHERE status IN ('settling', 'review') AND (buyer_id = $1 OR seller_id = $1)", [buyer.id]))[0]?.n === "0";

async function tradeStatus(tradeId: string): Promise<string | undefined> {
  return (await asAdmin<{ status: string }>("SELECT status FROM webdemo.trades WHERE id = $1", [tradeId]))[0]?.status;
}

describe.skipIf(!up)("demo market: DvP through the outbox and the signing service", () => {
  beforeAll(async () => {
    stack = await start();
    // Orders left open by earlier runs belong to other throw-away investors; keep them out of this run.
    await asAdmin("UPDATE webdemo.orders SET status = 'cancelled', note = 'previous test run' WHERE status = 'open'");
    [seller, buyer] = await Promise.all([onboardInvestor("Test Seller"), onboardInvestor("Test Buyer")]);
    const r = await invest(seller, { symbol: "GPF3", tokens: 200n, requestId: randomUUID() });
    if (!("subscriptionId" in r)) throw new Error(`refused: ${r.error}`);
    await until("the seller's tokens", async () => (await subscriptionById(seller.id, r.subscriptionId))?.status === "done");
    expect(await chainBalance(seller.wallet_address)).toBe(200n);
  });

  afterAll(async () => {
    await stopFollower();
    expect(await chainProblems(await db())).toBe(0);
    await stack.stop();
  });

  it("credits a top-up once even if the same request arrives three times", async () => {
    const requestId = randomUUID();
    await Promise.all([1, 2, 3].map(() => topUp(buyer, 100_000n * RS, requestId)));
    expect(await cashOf(buyer.id)).toBe(100_000n * RS);
  });

  it("refuses orders outside the price band, without enough cash or tokens, and self-trades", async () => {
    expect(await order(buyer, "buy", 551n, 10n)).toEqual({ error: "band" });
    expect(await order(buyer, "buy", 449n, 10n)).toEqual({ error: "band" });
    expect(await order(buyer, "buy", 500n, 9n)).toEqual({ error: "min" });
    expect(await order(buyer, "buy", 500n, 300n)).toEqual({ error: "noCash" });
    expect(await order(seller, "sell", 500n, 201n)).toEqual({ error: "noTokens" });
    const resting = id(await order(seller, "sell", 520n, 150n));
    expect(await order(seller, "sell", 520n, 60n)).toEqual({ error: "noTokens" }); // only 50 left unoffered
    await topUp(seller, 10_000n * RS, randomUUID());
    expect(await order(seller, "buy", 520n, 10n)).toEqual({ error: "selfTrade" });
    expect(await cancelOrder(seller, resting)).toBe(true);
    expect(await cashOf(buyer.id)).toBe(100_000n * RS); // nothing reserved by refused orders
  });

  it("settles at the maker's price: the trade is pending until the transfer is indexed, then the cash moves", async () => {
    const before = { sellerTokens: await chainBalance(seller.wallet_address), buyerTokens: await chainBalance(buyer.wallet_address), sellerCash: await cashOf(seller.id) };
    id(await order(seller, "sell", 505n, 30n)); // maker
    const buy = id(await order(buyer, "buy", 510n, 50n)); // taker: 30 trade at 505, 20 rest at 510
    // Matched and queued; while the transfer is in flight its cost stays in escrow and is not released.
    const { rows } = await (await db()).query<{ id: string; status: string }>("SELECT id, status FROM webdemo.trades WHERE buy_order = $1", [buy]);
    expect(rows.map((r) => r.status)).toEqual(["settling"]);
    expect(await cashOf(seller.id)).toBe(before.sellerCash);
    await until("the trade to settle", tradesOpen);
    expect(await tradeStatus(rows[0]?.id ?? "")).toBe("settled");
    expect(await chainBalance(buyer.wallet_address)).toBe(before.buyerTokens + 30n);
    expect(await chainBalance(seller.wallet_address)).toBe(before.sellerTokens - 30n);
    expect(await cashOf(seller.id)).toBe(before.sellerCash + 30n * 505n * RS);
    // The whole order was reserved at 510; the 5-rupee saving on the 30 filled stays in escrow until the order ends.
    expect(await cashOf(buyer.id)).toBe((100_000n - 50n * 510n) * RS);
    expect(await escrowOf(buyer.id)).toBe((50n * 510n - 30n * 505n) * RS);
    expect(await cancelOrder(buyer, buy)).toBe(true);
    expect(await cancelOrder(buyer, buy)).toBe(false); // second cancel does nothing
    expect(await escrowOf(buyer.id)).toBe(0n);
    expect(await cashOf(buyer.id)).toBe((100_000n - 30n * 505n) * RS);
  });

  it("cancelling a buy order while its trade is in flight keeps that trade's cost in escrow (DvP)", async () => {
    await stack.stopWorker();
    const sell = id(await order(seller, "sell", 500n, 10n));
    const buy = id(await order(buyer, "buy", 500n, 20n)); // 10 fill now, 10 rest
    expect(await cancelOrder(buyer, buy)).toBe(true);
    // Only the unfilled half went back to cash; the settling trade's 10 x 500 stays for delivery.
    expect(await escrowOf(buyer.id)).toBe(10n * 500n * RS);
    expect(await escrowMatches(buyer.id)).toBe(true);
    stack.startWorker();
    await until("the trade to settle", tradesOpen);
    expect(await escrowOf(buyer.id)).toBe(0n);
    expect(await escrowMatches(buyer.id)).toBe(true);
    await cancelOrder(seller, sell);
  });

  it("fills exactly what is offered when buyers and matchers race", async () => {
    const tokensBefore = await chainBalance(buyer.wallet_address);
    const cashBefore = await cashOf(buyer.id);
    const since = (await asAdmin<{ t: Date }>("SELECT clock_timestamp() AS t"))[0]?.t;
    id(await order(seller, "sell", 500n, 20n));
    const results = await Promise.all([order(buyer, "buy", 500n, 10n), order(buyer, "buy", 500n, 10n), order(buyer, "buy", 500n, 10n), runMatcher("GPF3"), runMatcher("GPF3")]);
    await runMatcher("GPF3");
    await until("the trades to settle", tradesOpen);
    expect(await chainBalance(buyer.wallet_address)).toBe(tokensBefore + 20n);
    const { rows } = await (await db()).query<{ n: string }>(
      "SELECT coalesce(sum(tokens), 0) AS n FROM webdemo.trades WHERE buyer_id = $1 AND price_paisa = 50000 AND status = 'settled' AND created_at >= $2",
      [buyer.id, since],
    );
    expect(BigInt(rows[0]?.n ?? "0")).toBe(20n);
    expect(await escrowOf(buyer.id)).toBe(10n * 500n * RS);
    expect(await cashOf(buyer.id)).toBe(cashBefore - 30n * 500n * RS);
    for (const r of results.slice(0, 3)) if (r && "orderId" in r) await cancelOrder(buyer, r.orderId);
    expect(await escrowOf(buyer.id)).toBe(0n);
  });

  it("a trade interrupted before Step 5h that never sent anything is undone and its escrow returned", async () => {
    const cashBefore = await cashOf(buyer.id);
    const ask = id(await order(seller, "sell", 530n, 10n));
    const bid = id(await order(buyer, "buy", 520n, 10n)); // does not cross
    const t = randomUUID();
    const pool = await db();
    for (const o of [bid, ask]) await pool.query("UPDATE webdemo.orders SET filled = filled + 5 WHERE id = $1", [o]);
    await pool.query(
      `INSERT INTO webdemo.trades (id, symbol, buy_order, sell_order, buyer_id, seller_id, price_paisa, tokens, status)
       VALUES ($1, 'GPF3', $2, $3, $4, $5, 52000, 5, 'review')`,
      [t, bid, ask, buyer.id, seller.id],
    );
    await until("the interrupted trade", async () => (await tradeStatus(t)) === "failed");
    expect(await escrowOf(buyer.id)).toBe(0n);
    expect(await cashOf(buyer.id)).toBe(cashBefore);
    expect(await escrowMatches(buyer.id)).toBe(true);
  });

  it("holds a large delivery for two operators, then delivers once approved", async () => {
    const big = await invest(seller, { symbol: "GPF3", tokens: 10_001n, requestId: randomUUID() });
    if (!("subscriptionId" in big)) throw new Error(`refused: ${big.error}`);
    const mintKey = `web:sub:${big.subscriptionId}:mint`;
    await until("the mint approval request", async () => (await signerRequestFor(mintKey))?.status === "pending_approval", 60_000);
    const mintReq = await signerRequestFor(mintKey);
    for (const op of ["ops-ana", "ops-bilal"]) await asAdmin("SELECT signer.decide($1, $2, 'approve', 'test approval')", [mintReq?.id, op]);
    // A mint above the threshold also needs the trustee's co-signature (migration 0023).
    await trusteeCosign(mintReq?.id ?? "");
    await until("the large mint", async () => (await subscriptionById(seller.id, big.subscriptionId))?.status === "done", 90_000);

    await topUp(buyer, 6_000_000n * RS, randomUUID());
    const before = await chainBalance(buyer.wallet_address);
    id(await order(seller, "sell", 500n, 10_001n));
    const buy = id(await order(buyer, "buy", 500n, 10_001n));
    const { rows } = await (await db()).query<{ id: string }>("SELECT id FROM webdemo.trades WHERE buy_order = $1", [buy]);
    const key = `web:trade:${rows[0]?.id ?? ""}:transfer`;
    await until("the delivery approval request", async () => (await signerRequestFor(key))?.status === "pending_approval", 60_000);
    expect(await chainBalance(buyer.wallet_address)).toBe(before);
    const req = await signerRequestFor(key);
    for (const op of ["ops-ana", "ops-bilal"]) await asAdmin("SELECT signer.decide($1, $2, 'approve', 'large trade checked')", [req?.id, op]);
    await until("the large trade to settle", tradesOpen, 90_000);
    expect(await chainBalance(buyer.wallet_address)).toBe(before + 10_001n);
  });

  it("an investor who loses KYC is frozen through the outbox; their trade is refused and undone, nothing moves", async () => {
    const freezeGuard = latestDeployment()?.get("freezeGuard");
    if (!freezeGuard || !seller.kyc_subject) throw new Error("set-up incomplete");
    const sell = id(await order(seller, "sell", 500n, 15n));
    await asAdmin("SELECT kyc.revoke($1, 'officer:test', 'Investor offboarded by compliance (test)')", [seller.kyc_subject]);
    await asAdmin("SELECT kyc.enqueue_offboarding($1, 'test')", [freezeGuard]);
    await until("the freeze", async () => (await asAdmin<{ status: string }>("SELECT status FROM outbox.commands WHERE kind = 'compliance.freeze' AND payload->>'account' = $1", [seller.wallet_address.toLowerCase()]))[0]?.status === "confirmed", 90_000);

    const tokensBefore = await chainBalance(buyer.wallet_address);
    const cashBefore = await cashOf(buyer.id);
    const buy = id(await order(buyer, "buy", 500n, 15n));
    await until("the refused trade to be undone", tradesOpen);
    expect(await chainBalance(buyer.wallet_address)).toBe(tokensBefore);
    expect(await cashOf(buyer.id)).toBe(cashBefore);
    expect(await escrowOf(buyer.id)).toBe(0n);
    const { rows } = await (await db()).query<{ id: string; status: string }>("SELECT id, status FROM webdemo.orders WHERE id = ANY($1) ORDER BY side", [[buy, sell]]);
    expect(rows.map((r) => r.status)).toEqual(["cancelled", "cancelled"]);
    const trade = await (await db()).query<{ status: string; note: string }>("SELECT status, note FROM webdemo.trades WHERE buy_order = $1", [buy]);
    expect(trade.rows[0]).toMatchObject({ status: "failed", note: expect.stringMatching(/frozen/) as unknown });
  });
});
