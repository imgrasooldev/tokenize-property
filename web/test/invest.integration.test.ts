import { randomUUID } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issuanceGuardAbi, tokenAbi } from "../src/lib/abis";
import { quotePaisa, refIdFor, MAX_HOLDING_TOKENS } from "../src/lib/invest-rules";
import { findProperty } from "../src/lib/properties";
import { latestDeployment } from "../src/lib/server/chain";
import { db, investorById, type InvestorRow } from "../src/lib/server/db";
import { LOCAL_CHAIN_ID, platformAccount, publicClient, sendAndWait } from "../src/lib/server/demo-signer";
import { BANK, capitalAccount, investorAccount, mint, placeOrder, reconcile, subscriptionById } from "../src/lib/server/invest";
import { balanceOf, chainProblems, openAccount, postJournal } from "../src/lib/server/ledger";
import { onboardOnChain } from "../src/lib/server/onboarding";

/**
 * Integration tests on the real local chain and the PostgreSQL TEST database (property_token_test).
 * Each run onboards a fresh investor on chain, so runs never interfere with each other or the demo.
 * Skipped when the local network or database is not running (as in CI).
 */
async function available(): Promise<boolean> {
  try {
    const [id] = await Promise.all([publicClient.getChainId(), (await db()).query("SELECT 1")]);
    return id === LOCAL_CHAIN_ID && latestDeployment() !== null;
  } catch {
    return false;
  }
}
const up = await available();

const P = findProperty("GPF3");
if (!P) throw new Error("GPF3 missing from the catalogue");
const d = latestDeployment();
let investor: InvestorRow;

async function insertInvestor(wallet: `0x${string}`, identity: `0x${string}` | null): Promise<InvestorRow> {
  const { rows } = await (await db()).query<{ id: string }>(
    `INSERT INTO webdemo.investors (display_name, wallet_address, identity_address, kyc_status)
     VALUES ('Test investor', $1, $2, 'verified') RETURNING id`,
    [wallet, identity],
  );
  const row = await investorById(rows[0]?.id ?? "");
  if (!row) throw new Error("insert failed");
  return row;
}

async function chainBalance(wallet: `0x${string}`): Promise<bigint> {
  const token = d?.get("token");
  if (!token) throw new Error("no token");
  return publicClient.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [wallet] });
}

async function journals(subId: string): Promise<string[]> {
  const { rows } = await (await db()).query<{ idempotency_key: string }>(
    "SELECT idempotency_key FROM ledger.journal WHERE idempotency_key LIKE $1 ORDER BY id",
    [`web:sub:${subId}:%`],
  );
  return rows.map((r) => r.idempotency_key.split(":").at(-1) ?? "");
}

/** Records a paid subscription exactly as placeOrder does, with a chosen refId and status. */
async function insertPaid(tokens: bigint, refId: `0x${string}`, status: "paid" | "review", id = randomUUID()): Promise<string> {
  if (!P) throw new Error("no property");
  const pool = await db();
  const amount = quotePaisa(P, tokens);
  await pool.query(
    `INSERT INTO webdemo.subscriptions (id, request_id, investor_id, symbol, tokens, amount_paisa, bank_ref, ref_id, status, updated_at)
     VALUES ($1, $2, $3, 'GPF3', $4, $5, 'RAAST-DEMO-0000000000AA', $6, $7, now() - interval '5 minutes')`,
    [id, randomUUID(), investor.id, tokens.toString(), amount.toString(), refId, status],
  );
  await openAccount(pool, BANK, "asset", "PKR");
  await openAccount(pool, investorAccount(investor.id), "liability", "PKR");
  await openAccount(pool, capitalAccount("GPF3"), "equity", "PKR");
  await postJournal(pool, {
    idempotencyKey: `web:sub:${id}:paid`,
    kind: "subscription_paid",
    createdBy: "test",
    postings: [
      { account: BANK, amount },
      { account: investorAccount(investor.id), amount: -amount },
    ],
  });
  return id;
}

describe.skipIf(!up)("invest flow on the local chain", () => {
  beforeAll(async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { identity } = await onboardOnChain(account, `test-${randomUUID()}`);
    investor = await insertInvestor(account.address, identity);
  });

  afterAll(async () => {
    expect(await chainProblems(await db())).toBe(0);
  });

  it("charges and mints exactly once when the same request arrives five times at once", async () => {
    const requestId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => placeOrder(investor, { symbol: "GPF3", tokens: 20n, requestId })),
    );
    const ids = new Set(results.map((r) => ("subscriptionId" in r ? r.subscriptionId : r.error)));
    expect(ids.size).toBe(1);
    const [id] = [...ids];
    const sub = await subscriptionById(investor.id, id ?? "");
    expect(sub?.status).toBe("done");
    expect(await journals(id ?? "")).toEqual(["paid", "settled"]);
    expect(await chainBalance(investor.wallet_address)).toBe(20n);
    const { rows } = await (await db()).query("SELECT 1 FROM webdemo.subscriptions WHERE request_id = $1", [requestId]);
    expect(rows).toHaveLength(1);
  });

  it("settles a second order and leaves nothing owed in the ledger", async () => {
    const r = await placeOrder(investor, { symbol: "GPF3", tokens: 30n, requestId: randomUUID() });
    expect("subscriptionId" in r).toBe(true);
    expect(await chainBalance(investor.wallet_address)).toBe(50n);
    expect(await balanceOf(await db(), investorAccount(investor.id))).toBe(0n);
  });

  it("refuses orders over the holding limit or under the minimum, without taking money", async () => {
    const before = await (await db()).query("SELECT count(*) AS n FROM webdemo.subscriptions WHERE investor_id = $1", [investor.id]);
    const held = await chainBalance(investor.wallet_address);
    expect(await placeOrder(investor, { symbol: "GPF3", tokens: MAX_HOLDING_TOKENS - held + 1n, requestId: randomUUID() })).toEqual({
      error: "maxHolding",
    });
    expect(await placeOrder(investor, { symbol: "GPF3", tokens: 5n, requestId: randomUUID() })).toEqual({ error: "min" });
    expect(await placeOrder(investor, { symbol: "DHA6", tokens: 50n, requestId: randomUUID() })).toEqual({ error: "notLive" });
    const after = await (await db()).query("SELECT count(*) AS n FROM webdemo.subscriptions WHERE investor_id = $1", [investor.id]);
    expect(after.rows).toEqual(before.rows);
  });

  it("refuses an investor who is not registered on chain, even if the database says verified", async () => {
    const stranger = await insertInvestor(privateKeyToAccount(generatePrivateKey()).address, null);
    expect(await placeOrder(stranger, { symbol: "GPF3", tokens: 50n, requestId: randomUUID() })).toEqual({ error: "unverified" });
  });

  it("refunds in full when the chain refuses the mint (reused refId), and mints nothing", async () => {
    const issuance = d?.get("issuance");
    if (!issuance) throw new Error("no issuance guard");
    // A refId already consumed on chain by someone else's mint (e.g. the scenario's), not yet in this table.
    const minted = await publicClient.getContractEvents({ address: issuance, abi: issuanceGuardAbi, eventName: "Minted", fromBlock: 0n });
    const { rows } = await (await db()).query<{ ref_id: string }>("SELECT ref_id FROM webdemo.subscriptions");
    const taken = new Set(rows.map((r) => r.ref_id));
    const used = minted.map((m) => m.args.refId).find((r) => r !== undefined && !taken.has(r));
    if (!used) throw new Error("no earlier mint left to reuse; reset the test database");

    const held = await chainBalance(investor.wallet_address);
    const id = await insertPaid(40n, used, "paid");
    await mint(id, investor.wallet_address);
    expect((await subscriptionById(investor.id, id))?.status).toBe("refunded");
    expect(await journals(id)).toEqual(["paid", "refunded"]);
    expect(await chainBalance(investor.wallet_address)).toBe(held);
    expect(await balanceOf(await db(), investorAccount(investor.id))).toBe(0n);
  });

  it("reconciles an unknown outcome to done only when the chain shows a matching mint", async () => {
    const issuance = d?.get("issuance");
    if (!issuance) throw new Error("no issuance guard");
    // The mint happened on chain, but the web request never learned the result.
    const id = randomUUID();
    const hash = await sendAndWait(platformAccount("ISSUANCE_SAFE"), {
      address: issuance,
      abi: issuanceGuardAbi,
      functionName: "mint",
      args: [investor.wallet_address, 15n, refIdFor(id)],
    });
    await insertPaid(15n, refIdFor(id), "review", id);
    // A second subscription claims 16 tokens under its own refId, which was never used: must stay in review.
    const pending = await insertPaid(16n, refIdFor(randomUUID()), "review");

    await reconcile(investor);
    const done = await subscriptionById(investor.id, id);
    expect(done?.status).toBe("done");
    expect(done?.mint_tx).toBe(hash);
    expect(await journals(id)).toEqual(["paid", "settled"]);
    expect((await subscriptionById(investor.id, pending))?.status).toBe("review");
    expect(await journals(pending)).toEqual(["paid"]);
  });

  it("does not settle when the refId was used for a different wallet or amount", async () => {
    const issuance = d?.get("issuance");
    if (!issuance) throw new Error("no issuance guard");
    const id = randomUUID();
    // Minted 11 tokens, but the subscription says 12: the amounts disagree.
    await sendAndWait(platformAccount("ISSUANCE_SAFE"), {
      address: issuance,
      abi: issuanceGuardAbi,
      functionName: "mint",
      args: [investor.wallet_address, 11n, refIdFor(id)],
    });
    await insertPaid(12n, refIdFor(id), "review", id);
    await reconcile(investor);
    const sub = await subscriptionById(investor.id, id);
    expect(sub?.status).toBe("review");
    expect(sub?.note).toMatch(/does not match/);
    expect(await journals(id)).toEqual(["paid"]);
  });
});
