import { randomBytes, randomUUID } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freezeGuardAbi, tokenAbi } from "../src/lib/abis";
import { latestDeployment } from "../src/lib/server/chain";
import { db, investorById, type InvestorRow } from "../src/lib/server/db";
import { LOCAL_CHAIN_ID, platformAccount, publicClient, send, sendAndWait, waitSuccess } from "../src/lib/server/demo-signer";
import { placeOrder as invest } from "../src/lib/server/invest";
import { chainProblems } from "../src/lib/server/ledger";
import { cancelOrder, cashOf, escrowMatches, escrowOf, placeOrder, runMatcher, topUp } from "../src/lib/server/market";
import { signerFor } from "../src/lib/server/wallets";
import { onboardOnChain } from "../src/lib/server/onboarding";

/**
 * W4 demo market on the real local chain and the PostgreSQL TEST database. Two fresh investors are
 * onboarded on chain per run; the seller gets tokens through the W3 invest flow.
 * Skipped when the local network or database is not running (as in CI).
 */
// Custodial keys of the fresh test investors are encrypted with a throw-away key for this run.
process.env.WEB_WALLET_KEY ??= randomBytes(32).toString("base64url");
const { encrypt } = await import("../src/lib/server/secrets");

async function available(): Promise<boolean> {
  try {
    const [id] = await Promise.all([publicClient.getChainId(), (await db()).query("SELECT 1")]);
    return id === LOCAL_CHAIN_ID && latestDeployment() !== null;
  } catch {
    return false;
  }
}
const up = await available();
const d = latestDeployment();
const RS = 100n;

let seller: InvestorRow;
let buyer: InvestorRow;

async function newInvestor(name: string): Promise<InvestorRow> {
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  const { identity } = await onboardOnChain(account, `test-${randomUUID()}`);
  const { rows } = await (await db()).query<{ id: string }>(
    `INSERT INTO webdemo.investors (display_name, wallet_address, wallet_key_enc, identity_address, kyc_status)
     VALUES ($1, $2, $3, $4, 'verified') RETURNING id`,
    [name, account.address, encrypt(key), identity],
  );
  const row = await investorById(rows[0]?.id ?? "");
  if (!row) throw new Error("insert failed");
  return row;
}

async function tokensOf(who: InvestorRow): Promise<bigint> {
  const token = d?.get("token");
  if (!token) throw new Error("no token");
  return publicClient.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [who.wallet_address] });
}

async function order(who: InvestorRow, side: "buy" | "sell", rupees: bigint, tokens: bigint) {
  return placeOrder(who, { symbol: "GPF3", side, price: rupees * RS, tokens, requestId: randomUUID() });
}

/** What the matcher records before sending, as if the process then crashed. */
async function recordInterruptedTrade(tradeId: string, buy: string, sell: string, rupees: bigint, tokens: bigint): Promise<void> {
  const pool = await db();
  for (const o of [buy, sell]) {
    await pool.query("UPDATE webdemo.orders SET filled = filled + $2 WHERE id = $1", [o, tokens.toString()]);
  }
  await pool.query(
    `INSERT INTO webdemo.trades (id, symbol, buy_order, sell_order, buyer_id, seller_id, price_paisa, tokens, status)
     VALUES ($1, 'GPF3', $2, $3, $4, $5, $6, $7, 'review')`,
    [tradeId, buy, sell, buyer.id, seller.id, (rupees * RS).toString(), tokens.toString()],
  );
}

async function tradeStatus(tradeId: string): Promise<string | undefined> {
  const { rows } = await (await db()).query<{ status: string }>("SELECT status FROM webdemo.trades WHERE id = $1", [tradeId]);
  return rows[0]?.status;
}

function id(r: Awaited<ReturnType<typeof placeOrder>>): string {
  if ("error" in r) throw new Error(`order refused: ${r.error}`);
  return r.orderId;
}

describe.skipIf(!up)("demo market on the local chain", () => {
  beforeAll(async () => {
    // Orders left open by earlier runs belong to other throw-away investors; keep them out of this run.
    await (await db()).query("UPDATE webdemo.orders SET status = 'cancelled', note = 'previous test run' WHERE status = 'open'");
    seller = await newInvestor("Test seller");
    buyer = await newInvestor("Test buyer");
    const r = await invest(seller, { symbol: "GPF3", tokens: 200n, requestId: randomUUID() });
    expect("subscriptionId" in r).toBe(true);
    expect(await tokensOf(seller)).toBe(200n);
  });

  afterAll(async () => {
    expect(await chainProblems(await db())).toBe(0);
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

  it("settles at the maker's price, moves tokens on chain first and returns unused escrow", async () => {
    const before = { sellerTokens: await tokensOf(seller), buyerTokens: await tokensOf(buyer), sellerCash: await cashOf(seller.id) };
    id(await order(seller, "sell", 505n, 30n)); // maker
    const buy = id(await order(buyer, "buy", 510n, 50n)); // taker: 30 trade at 505, 20 rest at 510

    expect(await tokensOf(buyer)).toBe(before.buyerTokens + 30n);
    expect(await tokensOf(seller)).toBe(before.sellerTokens - 30n);
    expect(await cashOf(seller.id)).toBe(before.sellerCash + 30n * 505n * RS);
    // The whole order was reserved at 510; the 5-rupee saving on the 30 filled stays in escrow until the order ends.
    expect(await cashOf(buyer.id)).toBe((100_000n - 50n * 510n) * RS);
    expect(await escrowOf(buyer.id)).toBe((50n * 510n - 30n * 505n) * RS);

    expect(await cancelOrder(buyer, buy)).toBe(true);
    expect(await cancelOrder(buyer, buy)).toBe(false); // second cancel does nothing
    expect(await escrowOf(buyer.id)).toBe(0n);
    expect(await cashOf(buyer.id)).toBe((100_000n - 30n * 505n) * RS);
  });

  it("fills exactly what is offered when buyers and matchers race", async () => {
    const tokensBefore = await tokensOf(buyer);
    const cashBefore = await cashOf(buyer.id);
    id(await order(seller, "sell", 500n, 20n));
    // Three buy orders of 10 at once, plus extra matcher runs: only 20 tokens exist to buy.
    const results = await Promise.all([
      order(buyer, "buy", 500n, 10n),
      order(buyer, "buy", 500n, 10n),
      order(buyer, "buy", 500n, 10n),
      runMatcher("GPF3"),
      runMatcher("GPF3"),
    ]);
    await runMatcher("GPF3");
    expect(await tokensOf(buyer)).toBe(tokensBefore + 20n);
    const { rows } = await (await db()).query<{ n: string }>(
      "SELECT coalesce(sum(tokens), 0) AS n FROM webdemo.trades WHERE buyer_id = $1 AND price_paisa = 50000 AND status = 'settled'",
      [buyer.id],
    );
    expect(BigInt(rows[0]?.n ?? "0")).toBe(20n);
    // One buy order is left with 10 open; its escrow is still reserved, the rest was spent.
    expect(await escrowOf(buyer.id)).toBe(10n * 500n * RS);
    expect(await cashOf(buyer.id)).toBe(cashBefore - 30n * 500n * RS);
    for (const r of results.slice(0, 3)) if (r && "orderId" in r) await cancelOrder(buyer, r.orderId);
    expect(await escrowOf(buyer.id)).toBe(0n);
  });

  it("after a crash, a trade that never sent anything is undone and its escrow returned", async () => {
    const cashBefore = await cashOf(buyer.id);
    const ask = id(await order(seller, "sell", 530n, 10n));
    const bid = id(await order(buyer, "buy", 520n, 10n)); // does not cross
    const t = randomUUID();
    await recordInterruptedTrade(t, bid, ask, 520n, 5n);
    await runMatcher("GPF3");
    expect(await tradeStatus(t)).toBe("failed");
    expect(await escrowOf(buyer.id)).toBe(0n);
    expect(await cashOf(buyer.id)).toBe(cashBefore);
    expect(await escrowMatches(buyer.id)).toBe(true);
  });

  it("after a crash, a transfer that was sent and mined is settled from its recorded hash", async () => {
    const token = d?.get("token");
    if (!token) throw new Error("no token");
    const sellerCash = await cashOf(seller.id);
    const buyerTokens = await tokensOf(buyer);
    const ask = id(await order(seller, "sell", 530n, 10n));
    const bid = id(await order(buyer, "buy", 520n, 10n));
    const t = randomUUID();
    await recordInterruptedTrade(t, bid, ask, 520n, 5n);
    // The transfer went out and was recorded (hash and nonce first), then the process died.
    const hash = await send(
      signerFor(seller),
      { address: token, abi: tokenAbi, functionName: "transfer", args: [buyer.wallet_address, 5n] },
      async (signed) => {
        await (await db()).query("UPDATE webdemo.trades SET transfer_tx = $2, transfer_nonce = $3 WHERE id = $1", [t, signed.hash, signed.nonce]);
      },
    );
    await waitSuccess(hash);
    await runMatcher("GPF3");
    expect(await tradeStatus(t)).toBe("settled");
    expect(await cashOf(seller.id)).toBe(sellerCash + 5n * 520n * RS);
    expect(await tokensOf(buyer)).toBe(buyerTokens + 5n);
    expect(await escrowOf(buyer.id)).toBe(5n * 520n * RS); // the other 5 are still on order
    expect(await escrowMatches(buyer.id)).toBe(true);
    await cancelOrder(buyer, bid);
    await cancelOrder(seller, ask);
    expect(await escrowOf(buyer.id)).toBe(0n);
  });

  it("undoes a trade the chain refuses (frozen seller): orders cancelled, escrow returned, no tokens move", async () => {
    const freezeGuard = d?.get("freezeGuard");
    if (!freezeGuard) throw new Error("no freeze guard");
    const caseId = `0x${randomBytes(32).toString("hex")}` as const;
    const sell = id(await order(seller, "sell", 500n, 15n));
    await sendAndWait(platformAccount("OPS_SAFE"), {
      address: freezeGuard,
      abi: freezeGuardAbi,
      functionName: "freezeAddress",
      args: [seller.wallet_address, caseId],
    });
    try {
      const tokensBefore = await tokensOf(buyer);
      const cashBefore = await cashOf(buyer.id);
      const buy = id(await order(buyer, "buy", 500n, 15n));
      expect(await tokensOf(buyer)).toBe(tokensBefore);
      expect(await cashOf(buyer.id)).toBe(cashBefore);
      expect(await escrowOf(buyer.id)).toBe(0n);
      const { rows } = await (await db()).query<{ id: string; status: string }>(
        "SELECT id, status FROM webdemo.orders WHERE id = ANY($1)",
        [[sell, buy]],
      );
      expect(rows.map((r) => r.status)).toEqual(["cancelled", "cancelled"]);
      const trade = await (await db()).query<{ status: string }>("SELECT status FROM webdemo.trades WHERE buy_order = $1", [buy]);
      expect(trade.rows[0]?.status).toBe("failed");
    } finally {
      await sendAndWait(platformAccount("OPS_SAFE"), {
        address: freezeGuard,
        abi: freezeGuardAbi,
        functionName: "unfreezeAddress",
        args: [seller.wallet_address, caseId],
      });
    }
  });
});
