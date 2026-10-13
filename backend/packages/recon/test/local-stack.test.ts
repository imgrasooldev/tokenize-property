import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { openAccount, postJournal } from "@pt/ledger";
import pg from "pg";
import { keccak256, stringToBytes, toHex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { scratchDatabase } from "../../db/test/helpers.ts";
import { bookRent, demoBankStatements, FLOW_REF_ID, seedLocal, type StatementFile } from "../../demo-console/src/booking.ts";
import { Indexer, verify, type Deployment } from "../../indexer/src/index.ts";
import { FakeChain, fakeDeployment } from "../../indexer/test/fake-chain.ts";
import type { ChainState } from "../src/chain.ts";
import { refIdForSubscription } from "../src/conventions.ts";
import { reconcile } from "../src/run.ts";

/**
 * Step 5h goal (ADR 0010): a freshly set-up local stack reconciles with ZERO findings. The stack is
 * replayed on a fake chain (real ABIs, real indexer) into a scratch database with every producer's
 * real bookings: chain/flow.py's scenario mint booked by `seed:local`, a website subscription and a
 * demo-market trade exactly as web/src/lib/server/invest.ts and market.ts book them (key
 * conventions of ADR 0007, checked against the website by its integration tests), rent published
 * and finalized with `rent:book`, and the demo bank's statements from `recon:demo-bank`. Then one
 * reconciliation run: zero findings, payouts not frozen. Each booking is also shown to be necessary.
 */
const MIGRATIONS = fileURLToPath(new URL("../../db/migrations", import.meta.url));
const ZERO = "0x0000000000000000000000000000000000000000";
const ALICE = `0x${"a1".repeat(20)}`;
const BOB = `0x${"b0".repeat(20)}`;
const NAV = 50_000n; // paisa per token (GPF3)

let admin: pg.Client;
let pool: pg.Pool;
let drop: () => Promise<void>;
const chain = new FakeChain();
let d: Deployment;
let indexer: Indexer;
const contract = { supply: 0n, balances: new Map<string, bigint>() };
const chainState: ChainState = {
  head: () => chain.head(),
  totalSupply: () => Promise.resolve(contract.supply),
  balances: (_t, holders) => Promise.resolve(new Map(holders.map((h) => [h, contract.balances.get(h) ?? 0n]))),
};

function mint(refId: string, to: string, amount: bigint): void {
  chain.mine(d, [
    { role: "issuance", name: "Minted", args: { to, amount, refId } },
    { role: "token", name: "Transfer", args: { from: ZERO, to, value: amount } },
  ]);
  contract.supply += amount;
  contract.balances.set(to, (contract.balances.get(to) ?? 0n) + amount);
}

function transfer(from: string, to: string, amount: bigint): void {
  chain.mine(d, [{ role: "token", name: "Transfer", args: { from, to, value: amount } }]);
  contract.balances.set(from, (contract.balances.get(from) ?? 0n) - amount);
  contract.balances.set(to, (contract.balances.get(to) ?? 0n) + amount);
}

const run = async () => {
  await indexer.catchUp();
  return reconcile(pool, {
    deployment: d,
    chain: chainState,
    actor: "test-local-stack",
    verifyIndexer: async () => {
      const v = await verify(pool, chain, d, { state: null });
      return { pinnedBlock: v.pinnedBlock, problems: v.problems };
    },
  });
};

/** What web/src/lib/server/invest.ts books for one subscription that minted and settled. */
async function webSubscription(investorId: string, wallet: string, tokens: bigint): Promise<void> {
  const id = randomUUID();
  const refId = refIdForSubscription(id);
  const amount = tokens * NAV;
  const bankRef = `RAAST-DEMO-${id.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      `INSERT INTO webdemo.subscriptions (id, request_id, investor_id, symbol, tokens, amount_paisa, bank_ref, ref_id, status)
       VALUES ($1, $2, $3, 'GPF3', $4, $5, $6, $7, 'minting')`,
      [id, randomUUID(), investorId, tokens.toString(), amount.toString(), bankRef, refId],
    );
    for (const [code, kind] of [["web:bank:subscriptions", "asset"], [`web:investor:${investorId}:subscription`, "liability"], ["web:property:gpf3:capital", "equity"]] as const) {
      await openAccount(c, { code, kind, asset: "PKR" });
    }
    await postJournal(c, { idempotencyKey: `web:sub:${id}:paid`, kind: "subscription_paid", externalRef: bankRef, createdBy: "web-prototype",
      postings: [{ account: "web:bank:subscriptions", amount }, { account: `web:investor:${investorId}:subscription`, amount: -amount }] });
    await c.query("SELECT outbox.enqueue($1, 'issuance.mint', $2::jsonb, $3, 'web', 5)", [`web:sub:${id}:mint`, JSON.stringify({ issuance: d.contracts.issuance, to: wallet, amount: tokens.toString(), refId }), `web:sub:${id}`]);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
  mint(refId, wallet, tokens);
  await postJournal(pool, { idempotencyKey: `web:sub:${id}:settled`, kind: "subscription_settled", externalRef: keccak256(toHex(`mint:${id}`)), createdBy: "web-prototype",
    postings: [{ account: `web:investor:${investorId}:subscription`, amount }, { account: "web:property:gpf3:capital", amount: -amount }] });
  await pool.query("UPDATE webdemo.subscriptions SET status = 'done' WHERE id = $1", [id]);
}

/** What web/src/lib/server/market.ts books: a top-up, a buy escrow and one settled DvP trade. */
async function webTrade(buyer: string, buyerWallet: string, seller: string, sellerWallet: string, tokens: bigint, price: bigint): Promise<void> {
  const topup = randomUUID();
  const order = randomUUID();
  const cost = tokens * price;
  const bankRef = `RAAST-DEMO-${topup.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  for (const [code, kind] of [["web:bank:client-money", "asset"], [`web:investor:${buyer}:cash`, "liability"], [`web:investor:${seller}:cash`, "liability"], [`web:order:${order}:escrow`, "liability"]] as const) {
    await openAccount(pool, { code, kind, asset: "PKR" });
  }
  await pool.query("INSERT INTO webdemo.topups (id, request_id, investor_id, amount_paisa, bank_ref) VALUES ($1, $2, $3, $4, $5)", [topup, randomUUID(), buyer, cost.toString(), bankRef]);
  await postJournal(pool, { idempotencyKey: `web:topup:${topup}`, kind: "cash_topup", externalRef: bankRef, createdBy: "web-market",
    postings: [{ account: "web:bank:client-money", amount: cost }, { account: `web:investor:${buyer}:cash`, amount: -cost }] });
  await postJournal(pool, { idempotencyKey: `web:order:${order}:reserve`, kind: "order_reserve", createdBy: "web-market",
    postings: [{ account: `web:investor:${buyer}:cash`, amount: cost }, { account: `web:order:${order}:escrow`, amount: -cost }] });
  transfer(sellerWallet, buyerWallet, tokens);
  await postJournal(pool, { idempotencyKey: `web:trade:${randomUUID()}:settle`, kind: "trade_settled", externalRef: keccak256(toHex(`transfer:${order}`)), createdBy: "web-market",
    postings: [{ account: `web:order:${order}:escrow`, amount: cost }, { account: `web:investor:${seller}:cash`, amount: -cost }] });
}

beforeAll(async () => {
  let settings: pg.ClientConfig;
  ({ client: admin, settings, drop } = await scratchDatabase());
  await migrate(admin, MIGRATIONS);
  pool = new pg.Pool({ ...settings, max: 6 });
  d = fakeDeployment(1n);
  indexer = new Indexer(pool, chain, d);
  await indexer.register();
});

afterAll(async () => {
  await pool.end();
  await drop();
});

describe("a freshly set-up local stack reconciles", () => {
  const contracts = (): { token: string; issuance: string; distributions: string } => ({
    token: d.contracts.token, issuance: d.contracts.issuance ?? "", distributions: d.contracts.distributions ?? "",
  });
  const statement = { token: "", recordBlock: 3, totalPaisa: 30_000_000, entitlements: [{ wallet: ALICE, amountPaisa: 25_000_000 }, { wallet: BOB, amountPaisa: 5_000_000 }] };
  let file: StatementFile;

  it("chain/flow.py alone: its scenario mint and its distribution; seed:local books the mint", async () => {
    // flow.py: 60,000 to Alice (refId 0xa1…a1), 10,000 to Bob, distribution 1 published (not finalized).
    mint(FLOW_REF_ID, ALICE, 60_000n);
    transfer(ALICE, BOB, 10_000n);
    statement.token = d.contracts.token;
    const canonical = JSON.stringify(statement);
    file = { id: 1, statementHash: keccak256(stringToBytes(canonical)), statement: canonical, entitlements: statement.entitlements };
    chain.mine(d, [{ role: "distributions", name: "DistributionPublished", args: { id: 1n, token: d.contracts.token, recordBlock: 3n, merkleRoot: keccak256(toHex("root")), totalPaisa: 30_000_000n, statementHash: file.statementHash } }]);
    await indexer.catchUp();

    const before = await run();
    expect(before.findings.map((f) => f.check)).toEqual(expect.arrayContaining(["issuance.orphan_mint", "cash.not_configured"]));
    // The seed refuses anything but exactly the scenario mint.
    await expect(seedLocal(pool, { contracts: contracts(), alice: BOB })).rejects.toThrow(/does not show the scenario mint/);
    expect(await seedLocal(pool, { contracts: contracts(), alice: ALICE })).toBe("booked");
    expect(await seedLocal(pool, { contracts: contracts(), alice: ALICE })).toBe("already booked");
  });

  it("the website's subscriptions and trades, rent:book and the demo bank: ZERO findings", async () => {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM webdemo.investors WHERE persona = 'ALICE'");
    const alice = rows[0]?.id ?? "";
    const { rows: b } = await pool.query<{ id: string }>("INSERT INTO webdemo.investors (persona, display_name, wallet_address, kyc_status) VALUES ('BOB', 'Bob (demo)', $1, 'verified') RETURNING id", [BOB]);
    const bob = b[0]?.id ?? "";
    await webSubscription(bob, BOB, 20n);
    await webSubscription(alice, ALICE, 35n);
    await webTrade(bob, BOB, alice, ALICE, 10n, 45_125n);

    // rent:book books the collection at publication; the split only once finalized (48 h on chain).
    expect(await bookRent(pool, { contracts: contracts(), statement: (id) => (id === "1" ? file : undefined) })).toEqual({ collected: [1n], distributed: [], missingStatement: [] });
    chain.mine(d, [{ role: "distributions", name: "DistributionFinalized", args: { id: 1n } }]);
    await indexer.catchUp();
    const missing = await run();
    expect(missing.findings.filter((f) => f.severity === "blocking").map((f) => f.check)).toEqual(["rent.missing_ledger"]);
    // A statement that is not the one the chain committed to is never booked.
    const forged = { ...file, entitlements: [{ wallet: ALICE, amountPaisa: 30_000_000 }] };
    expect((await bookRent(pool, { contracts: contracts(), statement: () => ({ ...forged, statement: `${forged.statement} ` }) })).missingStatement).toEqual([1n]);
    expect(await bookRent(pool, { contracts: contracts(), statement: (id) => (id === "1" ? file : undefined) })).toEqual({ collected: [], distributed: [1n], missingStatement: [] });

    // Without the bank's statements cash is not reconciled (a warning, still a finding).
    expect((await run()).findings.map((f) => f.check)).toEqual(["cash.not_configured"]);
    expect(await demoBankStatements(pool, { actor: "test-bank" })).toBe(2);
    expect(await demoBankStatements(pool, { actor: "test-bank" })).toBe(0); // idempotent

    const r = await run();
    expect(r.findings).toEqual([]);
    expect(r.status).toBe("passed");
    expect(r.summary.counts).toMatchObject({ issuances: 3, distributions: 1, bankAccounts: 2, expectedMints: 3 });
  });

  it("the demo bank compares independent records: a payment missing from the ledger is caught", async () => {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM webdemo.investors WHERE persona = 'ALICE'");
    // The demo bank shows a top-up the ledger never booked (a dropped journal, say).
    await pool.query("INSERT INTO webdemo.topups (id, request_id, investor_id, amount_paisa, bank_ref) VALUES ($1, $2, $3, 100, 'RAAST-DEMO-FFFFFFFFFFFF')", [randomUUID(), randomUUID(), rows[0]?.id]);
    // Tomorrow's statement carries it (today's is already imported and immutable).
    const tomorrow = new Date(Date.now() + 86_400_000 + 5 * 3_600_000).toISOString().slice(0, 10);
    await pool.query("UPDATE webdemo.topups SET created_at = ($2::date + time '07:00') AT TIME ZONE 'UTC' WHERE bank_ref = $1", ["RAAST-DEMO-FFFFFFFFFFFF", tomorrow]);
    expect(await demoBankStatements(pool, { actor: "test-bank", through: tomorrow })).toBe(2);
    const r = await run();
    expect(r.findings.filter((f) => f.severity === "blocking").map((f) => f.check).sort()).toEqual(["cash.closing_mismatch", "cash.unmatched_bank_line"]);
  });
});
