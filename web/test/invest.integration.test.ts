import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { quotePaisa, refIdFor, MAX_HOLDING_TOKENS } from "../src/lib/invest-rules";
import { findProperty } from "../src/lib/properties";
import { db, investorById, type InvestorRow } from "../src/lib/server/db";
import { stopFollower } from "../src/lib/server/follower";
import { BANK, capitalAccount, investorAccount, placeOrder, subscriptionById } from "../src/lib/server/invest";
import { balanceOf, chainProblems, openAccount, postJournal } from "../src/lib/server/ledger";
import { holdingOf } from "../src/lib/server/readmodel";
import { asAdmin, chainBalance, onboardInvestor, signerRequestFor, trusteeCosign, until } from "./helpers";
import { chainUp, prepare, start, type Stack } from "./stack";

/**
 * Invest flow end to end on the real local chain and the PostgreSQL TEST database (Step 5h,
 * ADR 0010): website -> ledger + outbox (one transaction) -> outbox worker -> signing service
 * (policy, maker-checker, nonce, audit) -> Besu -> indexer -> read model -> settlement follower ->
 * website read. A fresh investor is onboarded the same way per run. Skipped without a chain (CI).
 */
const up = await chainUp();
if (up) prepare();

const P = findProperty("GPF3");
if (!P) throw new Error("GPF3 missing from the catalogue");
let investor: InvestorRow;
let stack: Stack;

async function journals(subId: string): Promise<string[]> {
  const rows = await asAdmin<{ idempotency_key: string }>("SELECT idempotency_key FROM ledger.journal WHERE idempotency_key LIKE $1 ORDER BY id", [`web:sub:${subId}:%`]);
  return rows.map((r) => r.idempotency_key.split(":").at(-1) ?? "");
}

const statusOf = async (id: string) => (await subscriptionById(investor.id, id))?.status;

/** A subscription recorded as by the website BEFORE Step 5h (status "paid", no outbox command yet). */
async function insertLegacyPaid(who: InvestorRow, tokens: bigint, id = randomUUID()): Promise<string> {
  if (!P) throw new Error("no property");
  const pool = await db();
  const amount = quotePaisa(P, tokens);
  // A unique bank reference per payment, as the bank gives (the demo bank's statements need it).
  const bankRef = `RAAST-DEMO-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  await pool.query(
    `INSERT INTO webdemo.subscriptions (id, request_id, investor_id, symbol, tokens, amount_paisa, bank_ref, ref_id, status, updated_at)
     VALUES ($1, $2, $3, 'GPF3', $4, $5, $6, $7, 'paid', now() - interval '5 minutes')`,
    [id, randomUUID(), who.id, tokens.toString(), amount.toString(), bankRef, refIdFor(id)],
  );
  await openAccount(pool, BANK, "asset", "PKR");
  await openAccount(pool, investorAccount(who.id), "liability", "PKR");
  await openAccount(pool, capitalAccount("GPF3"), "equity", "PKR");
  await postJournal(pool, {
    idempotencyKey: `web:sub:${id}:paid`,
    kind: "subscription_paid",
    externalRef: bankRef,
    createdBy: "test",
    postings: [
      { account: BANK, amount },
      { account: investorAccount(who.id), amount: -amount },
    ],
  });
  return id;
}

describe.skipIf(!up)("invest through the outbox and the signing service", () => {
  beforeAll(async () => {
    stack = await start();
    investor = await onboardInvestor("Test Investor");
  });

  afterAll(async () => {
    await stopFollower();
    expect(await chainProblems(await db())).toBe(0);
    await stack.stop();
  });

  it("charges and mints exactly once when the same request arrives five times at once, and shows it only once indexed", async () => {
    const requestId = randomUUID();
    const before = await chainBalance(investor.wallet_address);
    const results = await Promise.all(Array.from({ length: 5 }, () => placeOrder(investor, { symbol: "GPF3", tokens: 20n, requestId })));
    const ids = new Set(results.map((r) => ("subscriptionId" in r ? r.subscriptionId : r.error)));
    expect(ids.size).toBe(1);
    const [id = ""] = [...ids];
    // Accepted, queued: paid in the ledger, not yet done.
    expect(await statusOf(id)).toBe("minting");
    expect(await journals(id)).toEqual(["paid"]);
    await until("the mint to settle", async () => (await statusOf(id)) === "done");
    expect(await journals(id)).toEqual(["paid", "settled"]);
    expect(await chainBalance(investor.wallet_address)).toBe(before + 20n);
    // The website's read (read model) agrees with the chain once settled.
    expect(await holdingOf(investor.wallet_address)).toBe(before + 20n);
    const cmds = await asAdmin<{ status: string; n: string }>("SELECT status, count(*) AS n FROM outbox.commands WHERE ref = $1 GROUP BY status", [`web:sub:${id}`]);
    expect(cmds).toEqual([{ status: "confirmed", n: "1" }]);
  });

  it("settles a second order and leaves nothing owed in the ledger", async () => {
    const r = await placeOrder(investor, { symbol: "GPF3", tokens: 30n, requestId: randomUUID() });
    if (!("subscriptionId" in r)) throw new Error(`refused: ${r.error}`);
    await until("the mint to settle", async () => (await statusOf(r.subscriptionId)) === "done");
    expect(await balanceOf(await db(), investorAccount(investor.id))).toBe(0n);
  });

  it("refuses orders over the holding limit (counting what is still in flight) or under the minimum, without taking money", async () => {
    const before = await asAdmin<{ n: string }>("SELECT count(*) AS n FROM webdemo.subscriptions WHERE investor_id = $1", [investor.id]);
    const held = await chainBalance(investor.wallet_address);
    expect(await placeOrder(investor, { symbol: "GPF3", tokens: MAX_HOLDING_TOKENS - held + 1n, requestId: randomUUID() })).toEqual({ error: "maxHolding" });
    expect(await placeOrder(investor, { symbol: "GPF3", tokens: 5n, requestId: randomUUID() })).toEqual({ error: "min" });
    expect(await placeOrder(investor, { symbol: "DHA6", tokens: 50n, requestId: randomUUID() })).toEqual({ error: "notLive" });
    expect(await asAdmin("SELECT count(*) AS n FROM webdemo.subscriptions WHERE investor_id = $1", [investor.id])).toEqual(before);
  });

  it("refuses an investor who is not registered on chain, even if the website's record says verified", async () => {
    const { rows } = await (await db()).query<{ id: string }>(
      "INSERT INTO webdemo.investors (display_name, wallet_address, kyc_status) VALUES ('Stranger', $1, 'verified') RETURNING id",
      [`0x${randomUUID().replaceAll("-", "").padEnd(40, "0").slice(0, 40)}`],
    );
    const stranger = await investorById(rows[0]?.id ?? "");
    if (!stranger) throw new Error("insert failed");
    expect(await placeOrder(stranger, { symbol: "GPF3", tokens: 50n, requestId: randomUUID() })).toEqual({ error: "unverified" });
  });

  it("refunds in full when the signing service refuses the mint (recipient not verified), and mints nothing", async () => {
    // A subscription the website accepted for a wallet the identity registry does not know (as if
    // the investor had been offboarded in between): the policy denies it before anything is sent.
    const { rows } = await (await db()).query<{ id: string }>(
      "INSERT INTO webdemo.investors (display_name, wallet_address, kyc_status) VALUES ('Gone Investor', $1, 'verified') RETURNING id",
      [`0x${randomUUID().replaceAll("-", "").padEnd(40, "1").slice(0, 40)}`],
    );
    const gone = await investorById(rows[0]?.id ?? "");
    if (!gone) throw new Error("insert failed");
    const id = await insertLegacyPaid(gone, 40n);
    await until("the refusal to be refunded", async () => (await subscriptionById(gone.id, id))?.status === "refunded");
    const sub = await subscriptionById(gone.id, id);
    expect(sub?.note).toMatch(/not verified/);
    expect(sub?.note).toMatch(/no transaction was ever sent/);
    expect(await journals(id)).toEqual(["paid", "refunded"]);
    expect(await chainBalance(gone.wallet_address)).toBe(0n);
    expect(await balanceOf(await db(), investorAccount(gone.id))).toBe(0n);
  });

  it("holds a large subscription for two operators (maker-checker), then mints it once approved", async () => {
    const before = await chainBalance(investor.wallet_address);
    const r = await placeOrder(investor, { symbol: "GPF3", tokens: 10_001n, requestId: randomUUID() });
    if (!("subscriptionId" in r)) throw new Error(`refused: ${r.error}`);
    const key = `web:sub:${r.subscriptionId}:mint`;
    await until("the signing request", async () => (await signerRequestFor(key))?.status === "pending_approval", 60_000);
    const req = await signerRequestFor(key);
    if (!req) throw new Error("no signing request");
    // Nothing moves while it waits.
    await new Promise((res) => setTimeout(res, 3_000));
    expect(await statusOf(r.subscriptionId)).toBe("minting");
    expect(await chainBalance(investor.wallet_address)).toBe(before);
    // The requester (the outbox worker) can never approve its own request; two distinct operators and the trustee can.
    await expect(asAdmin("SELECT signer.decide($1, 'outbox-worker', 'approve', 'self')", [req.id])).rejects.toThrow(/maker-checker/);
    await asAdmin("SELECT signer.decide($1, 'ops-ana', 'approve', 'subscription and payment checked')", [req.id]);
    await asAdmin("SELECT signer.decide($1, 'ops-bilal', 'approve', 'second platform check')", [req.id]);
    // A mint above the threshold also needs the trustee's co-signature (migration 0023).
    expect(await trusteeCosign(req.id)).toBe("approved");
    await until("the approved mint to settle", async () => (await statusOf(r.subscriptionId)) === "done", 90_000);
    expect(await chainBalance(investor.wallet_address)).toBe(before + 10_001n);
  });

  it("after a worker crash, retries without a double mint", async () => {
    const before = await chainBalance(investor.wallet_address);
    // The worker dies; a command is claimed by a worker that then crashes before recording anything.
    await stack.stopWorker();
    const r = await placeOrder(investor, { symbol: "GPF3", tokens: 12n, requestId: randomUUID() });
    if (!("subscriptionId" in r)) throw new Error(`refused: ${r.error}`);
    const claimed = await asAdmin<{ idempotency_key: string }>("SELECT idempotency_key FROM outbox.claim('crashed-test-worker', 20, 5)");
    expect(claimed.map((c) => c.idempotency_key)).toContain(`web:sub:${r.subscriptionId}:mint`);
    // A legacy "paid" row (crash between payment and mint before Step 5h) is picked up as well.
    const legacy = await insertLegacyPaid(investor, 13n);
    // The follower, run many times meanwhile, never sends anything itself and never enqueues twice.
    for (let i = 0; i < 3; i++) await until("nothing", () => Promise.resolve(true));
    stack.startWorker();
    await until("both to settle", async () => (await statusOf(r.subscriptionId)) === "done" && (await statusOf(legacy)) === "done", 120_000);
    expect(await chainBalance(investor.wallet_address)).toBe(before + 25n);
    for (const id of [r.subscriptionId, legacy]) {
      expect(await journals(id)).toEqual(["paid", "settled"]);
      const cmds = await asAdmin<{ n: string }>("SELECT count(*) AS n FROM outbox.commands WHERE ref = $1", [`web:sub:${id}`]);
      expect(cmds[0]?.n).toBe("1");
    }
  });

  it("keeps the signing audit chain intact", async () => {
    expect(await asAdmin("SELECT * FROM signer.verify_audit()")).toEqual([]);
  });
});
