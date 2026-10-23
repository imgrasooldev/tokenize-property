import { fileURLToPath } from "node:url";
import { openAccount, postJournal } from "@pt/ledger";
import pg from "pg";
import { keccak256, toHex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { scratchDatabase, serviceLogin } from "../../db/test/helpers.ts";
import { Indexer, verify, type Deployment } from "../../indexer/src/index.ts";
import { FakeChain, fakeDeployment } from "../../indexer/test/fake-chain.ts";
import { payoutGateDenial } from "../../signer/src/service.ts";
import { buildStatement, importStatement } from "../src/bank.ts";
import type { ChainState } from "../src/chain.ts";
import { payoutBatchHash, pktDate } from "../src/conventions.ts";
import { reconcile } from "../src/run.ts";
import { decideUnfreeze, payoutGate, registerBankAccount, requestUnfreeze } from "../src/store.ts";

/**
 * End to end without Besu: a fake chain (real ABIs) indexed by the real indexer into a scratch
 * database, the real ledger and outbox functions, a mock bank statement, then full runs. Shows the
 * whole loop: clean data passes with zero findings, a discrepancy freezes payouts (and the signer's
 * payout gate denies), maker-checker unfreezes, and tampering is caught.
 */
const MIGRATIONS = fileURLToPath(new URL("../../db/migrations", import.meta.url));
const ZERO = "0x0000000000000000000000000000000000000000";
const BANK_LEDGER = "web:bank:subscriptions";
const W1 = `0x${"a1".repeat(20)}`;
const W2 = `0x${"b2".repeat(20)}`;

let admin: pg.Client;
let pool: pg.Pool;
/** The run itself connects as a login in pt_svc_recon (T-012, migration 0029), as the daily job does; `pool` (admin) builds the fixtures. */
let reconPool: pg.Pool;
let reconLogin: Awaited<ReturnType<typeof serviceLogin>>;
let drop: () => Promise<void>;
const chain = new FakeChain();
let d: Deployment;
let indexer: Indexer;

/** What the contracts answer; tests can make the "chain" disagree with the read model. */
const contract = { supply: 0n, balances: new Map<string, bigint>(), fail: false };
const chainState: ChainState = {
  head: () => chain.head(),
  totalSupply: () => (contract.fail ? Promise.reject(new Error("node unreachable")) : Promise.resolve(contract.supply)),
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

/** A paid and settled subscription in the ledger plus its outbox command (backend convention). */
async function subscription(refId: string, to: string, tokens: bigint, paisa: bigint, bankRef: string): Promise<void> {
  const investor = `web:investor:${refId.slice(2, 10)}:subscription`;
  await openAccount(pool, { code: investor, kind: "liability", asset: "PKR" });
  await postJournal(pool, { idempotencyKey: `sub:${refId}:paid`, kind: "subscription_paid", externalRef: bankRef, createdBy: "test", postings: [{ account: BANK_LEDGER, amount: paisa }, { account: investor, amount: -paisa }] });
  await pool.query("SELECT outbox.enqueue($1, 'issuance.mint', $2::jsonb, $3, 'test')", [`mint:${refId}`, JSON.stringify({ issuance: d.contracts.issuance, to, amount: tokens.toString(), refId }), refId]);
  await postJournal(pool, { idempotencyKey: `sub:${refId}:settled`, kind: "subscription_settled", externalRef: keccak256(toHex(`tx:${refId}`)), createdBy: "test", postings: [{ account: investor, amount: paisa }, { account: "web:property:test:capital", amount: -paisa }] });
}

/** The bank's view: one statement per PKT day with a line for every ledger posting on the escrow account. */
async function importBankFromLedger(): Promise<void> {
  const { rows } = await admin.query<{ created_at: Date; external_ref: string; amount: string }>(
    `SELECT j.created_at, j.external_ref, p.amount::text FROM ledger.postings p JOIN ledger.journal j ON j.id = p.journal_id
     JOIN ledger.accounts a ON a.id = p.account_id WHERE a.code = $1 ORDER BY p.id`, [BANK_LEDGER]);
  let opening = 0n;
  for (const date of [...new Set(rows.map((r) => pktDate(r.created_at)))]) {
    const st = buildStatement("TRUSTEE-ESCROW-01", date, opening, rows.filter((r) => pktDate(r.created_at) === date)
      .map((r) => ({ valueDate: date, amountPaisa: BigInt(r.amount), reference: r.external_ref, counterparty: "test" })));
    await importStatement(admin, st, "bank-import");
    opening = st.closingPaisa;
  }
}

const run = async (opts: { verify?: boolean } = {}) => {
  await indexer.catchUp();
  return reconcile(reconPool, {
    deployment: d,
    chain: chainState,
    actor: "test-recon",
    verifyIndexer: opts.verify === false ? null : async () => {
      const v = await verify(reconPool, chain, d, { state: null });
      return { pinnedBlock: v.pinnedBlock, problems: v.problems };
    },
  });
};

beforeAll(async () => {
  let settings: pg.ClientConfig;
  ({ client: admin, settings, drop } = await scratchDatabase());
  await migrate(admin, MIGRATIONS);
  pool = new pg.Pool({ ...settings, max: 6 });
  reconLogin = await serviceLogin("recon", String(settings.database));
  reconPool = new pg.Pool({ ...reconLogin.settings, max: 4 });
  d = fakeDeployment(1n);
  indexer = new Indexer(pool, chain, d);
  await indexer.register();
  for (const [code, kind] of [[BANK_LEDGER, "asset"], ["web:property:test:capital", "equity"], ["income:rent", "income"], ["payable:rent", "liability"]] as const) {
    await openAccount(pool, { code, kind, asset: "PKR" });
  }
});

afterAll(async () => {
  await pool.end();
  await reconPool.end();
  await drop();
  await reconLogin.drop();
});

describe("reconcile end to end (fake chain, real database)", () => {
  const R1 = keccak256(toHex("subscription-1"));
  const R2 = keccak256(toHex("subscription-2"));
  const statementHash = keccak256(toHex("rent statement 1"));
  const batch = "RAAST-BATCH-000001";

  it("freezes payouts on an orphan mint; the signer's payout gate denies", async () => {
    await subscription(R1, W1, 100n, 100_000n, "RAAST-DEMO-000000000001");
    mint(R1, W1, 100n);
    // Rent: received, published, finalized, booked, paid out, recorded on chain.
    await postJournal(pool, { idempotencyKey: "tenant:rent:000001", kind: "rent_received", externalRef: "RAAST-RENT-000001", createdBy: "test", postings: [{ account: BANK_LEDGER, amount: 30_000n }, { account: "income:rent", amount: -30_000n }] });
    chain.mine(d, [{ role: "distributions", name: "DistributionPublished", args: { id: 1n, token: d.contracts.token, recordBlock: 1n, merkleRoot: keccak256(toHex("root")), totalPaisa: 30_000n, statementHash } }]);
    chain.mine(d, [{ role: "distributions", name: "DistributionFinalized", args: { id: 1n } }]);
    await postJournal(pool, { idempotencyKey: `rent:distribution:${d.contracts.token}:1`, kind: "rent_distribution", externalRef: statementHash, createdBy: "test", postings: [{ account: "income:rent", amount: 30_000n }, { account: "payable:rent", amount: -30_000n }] });
    await postJournal(pool, { idempotencyKey: `rent:payout:${d.contracts.token}:1`, kind: "rent_payout", externalRef: batch, createdBy: "test", postings: [{ account: "payable:rent", amount: 30_000n }, { account: BANK_LEDGER, amount: -30_000n }] });
    chain.mine(d, [{ role: "distributions", name: "PayoutRecorded", args: { id: 1n, payoutBatchHash: payoutBatchHash(batch) } }]);
    // A mint nobody paid for.
    mint(R2, W2, 7n);

    const r = await run();
    expect(r.status).toBe("failed");
    expect(r.findings.filter((f) => f.severity === "blocking").map((f) => [f.check, f.subject])).toEqual([["issuance.orphan_mint", `refId ${R2}`]]);
    expect(r.findings.map((f) => f.check)).toContain("cash.not_configured");
    expect(r.pinnedBlock).toBe(chain.tip);
    expect(await payoutGate(pool)).toMatchObject({ allowed: false, frozen: true });

    const c = await pool.connect();
    try {
      expect(await payoutGateDenial(c, "payout.bank_batch")).toMatch(/frozen/);
      expect(await payoutGateDenial(c, "rent.payout")).toMatch(/frozen/);
      expect(await payoutGateDenial(c, "issuance.mint")).toBeNull(); // not a payout
    } finally {
      c.release();
    }
  });

  it("passes with ZERO findings once ledger, chain and bank agree, but stays frozen until two operators unfreeze", async () => {
    await subscription(R2, W2, 7n, 7_000n, "RAAST-DEMO-000000000002");
    await registerBankAccount(pool, "TRUSTEE-ESCROW-01", BANK_LEDGER, "ops-1");
    await importBankFromLedger();

    const r = await run();
    expect(r.findings).toEqual([]);
    expect(r.status).toBe("passed");
    expect(String(r.summary.indexerVerify)).toMatch(/^ran at block/);
    expect(r.summary.counts).toMatchObject({ issuances: 2, distributions: 1, bankAccounts: 1 });
    expect(await payoutGate(pool)).toMatchObject({ allowed: false, frozen: true });

    const req = await requestUnfreeze(pool, "ops-1", "orphan mint was a missing ledger entry, now booked");
    await expect(decideUnfreeze(pool, req, "ops-1", "approve", "approving my own request")).rejects.toThrow(/maker-checker/);
    expect(await decideUnfreeze(pool, req, "ops-2", "approve", "checked the booking and the clean run")).toBe("approved");
    expect((await payoutGate(pool)).allowed).toBe(true);
    const c = await pool.connect();
    try {
      expect(await payoutGateDenial(c, "payout.bank_batch")).toBeNull();
    } finally {
      c.release();
    }
  });

  it("ends in error (no freeze, payouts denied) when the chain cannot be read, and passes again after", async () => {
    contract.fail = true;
    const r = await run();
    contract.fail = false;
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/node unreachable/);
    expect(await payoutGate(pool)).toMatchObject({ allowed: false, frozen: false, lastStatus: "error" });
    expect((await run()).status).toBe("passed");
    expect((await payoutGate(pool)).allowed).toBe(true);
  });

  it("catches a chain that disagrees with the read model, a wrong statement hash and a tampered ledger row", async () => {
    contract.balances.set(W1, 99n); // balanceOf on chain differs from the read model
    const dist2Hash = keccak256(toHex("rent statement 2"));
    await openAccount(pool, { code: "income:rent:2", kind: "income", asset: "PKR", allowOverdraft: true });
    chain.mine(d, [{ role: "distributions", name: "DistributionPublished", args: { id: 2n, token: d.contracts.token, recordBlock: 2n, merkleRoot: keccak256(toHex("root2")), totalPaisa: 5_000n, statementHash: dist2Hash } }]);
    chain.mine(d, [{ role: "distributions", name: "DistributionFinalized", args: { id: 2n } }]);
    await postJournal(pool, { idempotencyKey: `rent:distribution:${d.contracts.token}:2`, kind: "rent_distribution", externalRef: keccak256(toHex("a different statement")), createdBy: "test", postings: [{ account: "income:rent:2", amount: 5_000n }, { account: "payable:rent", amount: -5_000n }] });
    await admin.query("ALTER TABLE ledger.postings DISABLE TRIGGER postings_append_only");
    await admin.query("UPDATE ledger.postings SET amount = amount + 1 WHERE id = (SELECT min(id) FROM ledger.postings)");
    await admin.query("ALTER TABLE ledger.postings ENABLE TRIGGER postings_append_only");

    const r = await run();
    expect(r.status).toBe("failed");
    expect(new Set(r.findings.map((f) => f.check))).toEqual(new Set([
      "holdings.balance_mismatch", "holdings.missing_holder", "rent.statement_hash_mismatch", "integrity.ledger_chain",
      // Since 0008 the edited posting also no longer matches its account's running balance.
      "integrity.ledger_balances",
      // The tampered posting is subscription 1's payment: the settlement and the bank no longer agree.
      "issuance.settlement_mismatch", "cash.amount_mismatch", "cash.closing_mismatch",
    ]));
    expect(await payoutGate(pool)).toMatchObject({ allowed: false, frozen: true });
    expect((await pool.query("SELECT * FROM recon.verify_audit()")).rows).toEqual([]);
  });
});
