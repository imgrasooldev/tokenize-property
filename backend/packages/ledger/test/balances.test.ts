import { rmSync } from "node:fs";
import fc from "fast-check";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { addMigrationsAfter, migrationsUpTo, scratchDatabase } from "../../db/test/helpers.ts";
import { balanceOf, LedgerError, openAccount, postJournal, verifyChain } from "../src/index.ts";

/**
 * RF-2 and RF-3 (migration 0008): running balances replace the full-history overdraft scan, and
 * missing posting fields are rejected by validation. The database starts at 0007 with real
 * history, then is upgraded, so the backfill is tested on data written by the old code.
 */
let db: pg.Client;
let drop: () => Promise<void>;
let dir: string;
let n = 0;
const key = (label: string) => `rf:${label}:${String(++n)}:${String(Date.now())}`;

async function transfer(from: string, to: string, amount: bigint, label = "t"): Promise<bigint> {
  return postJournal(db, {
    idempotencyKey: key(label),
    kind: "transfer",
    createdBy: "test",
    postings: [
      { account: to, amount },
      { account: from, amount: -amount },
    ],
  });
}

async function verifyBalances(): Promise<{ code: string; cached: string | null; actual: string }[]> {
  const { rows } = await db.query<{ code: string; cached: string | null; actual: string }>(
    "SELECT code, cached::text, actual::text FROM ledger.verify_balances()",
  );
  return rows;
}

beforeAll(async () => {
  ({ client: db, drop } = await scratchDatabase());
  dir = migrationsUpTo("0007");
  await migrate(db, dir);
  await openAccount(db, { code: "bank:escrow", kind: "asset", asset: "PKR" });
  await openAccount(db, { code: "income:rent", kind: "income", asset: "PKR", allowOverdraft: true });
  await openAccount(db, { code: "investor:a:payable", kind: "liability", asset: "PKR" });
  await openAccount(db, { code: "investor:b:payable", kind: "liability", asset: "PKR" });
  // History written by the pre-0008 code.
  for (let i = 0; i < 40; i++) {
    await transfer("income:rent", "bank:escrow", 1_000n + BigInt(i), "old-rent");
    await transfer("investor:a:payable", "income:rent", 300n, "old-accrue-a"); // income debit, payable credit (owed)
  }
});

afterAll(async () => {
  await drop();
  rmSync(dir, { recursive: true, force: true });
});

describe("RF-2 running balances", () => {
  it("the upgrade backfills every balance from the existing postings", async () => {
    const before = await db.query<{ code: string; balance: string }>("SELECT code, balance::text FROM ledger.balances ORDER BY code");
    addMigrationsAfter(dir, "0007");
    await migrate(db, dir);
    const after = await db.query<{ code: string; balance: string }>("SELECT code, balance::text FROM ledger.balances ORDER BY code");
    // Later migrations may open new accounts (0009: bank escrow and suspense), always at zero.
    const existed = new Set(before.rows.map((r) => r.code));
    expect(after.rows.filter((r) => existed.has(r.code))).toEqual(before.rows);
    expect(after.rows.filter((r) => !existed.has(r.code)).every((r) => r.balance === "0")).toBe(true);
    expect(await verifyBalances()).toEqual([]);
    expect(await verifyChain(db)).toEqual([]);
  });

  it("L-6 is still enforced, now from the running balance", async () => {
    const owed = -(await balanceOf(db, "investor:a:payable")); // credit-normal: owed amount
    await expect(
      postJournal(db, {
        idempotencyKey: key("overpay"),
        kind: "payout",
        createdBy: "test",
        postings: [
          { account: "investor:a:payable", amount: owed + 1n },
          { account: "bank:escrow", amount: -(owed + 1n) },
        ],
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof LedgerError && e.code === "INSUFFICIENT_BALANCE");
    await postJournal(db, {
      idempotencyKey: key("pay"),
      kind: "payout",
      createdBy: "test",
      postings: [
        { account: "investor:a:payable", amount: owed },
        { account: "bank:escrow", amount: -owed },
      ],
    });
    expect(await balanceOf(db, "investor:a:payable")).toBe(0n);
    expect(await verifyBalances()).toEqual([]);
  });

  it("a refused journal leaves no trace in the running balances", async () => {
    const before = await db.query("SELECT account_id, balance, last_journal_id FROM ledger.account_balances ORDER BY account_id");
    // Paying Bob, who is owed nothing: debit his payable, credit escrow.
    await expect(transfer("bank:escrow", "investor:b:payable", 5n)).rejects.toThrow(/insufficient balance/);
    const after = await db.query("SELECT account_id, balance, last_journal_id FROM ledger.account_balances ORDER BY account_id");
    expect(after.rows).toEqual(before.rows);
  });

  it("property: for any sequence of journals the running balance equals the sum of postings", async () => {
    const accounts = ["p:a", "p:b", "p:c", "p:d"];
    for (const code of accounts) await openAccount(db, { code, kind: "asset", asset: "PKR", allowOverdraft: true });
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({ from: fc.constantFrom(...accounts), to: fc.constantFrom(...accounts), amount: fc.bigInt({ min: 1n, max: 10n ** 15n }) }),
          { minLength: 1, maxLength: 10 },
        ),
        async (moves) => {
          for (const m of moves) if (m.from !== m.to) await transfer(m.from, m.to, m.amount, "prop");
          expect(await verifyBalances()).toEqual([]);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("the running balance cannot be edited, moved backwards or deleted, even by the admin", async () => {
    await expect(db.query("UPDATE ledger.account_balances SET balance = balance + 1")).rejects.toThrow(/not allowed/);
    await expect(db.query("UPDATE ledger.account_balances SET last_journal_id = last_journal_id - 1")).rejects.toThrow(/not allowed/);
    await expect(db.query("DELETE FROM ledger.account_balances")).rejects.toThrow(/not allowed/);
    await expect(db.query("TRUNCATE ledger.account_balances")).rejects.toThrow(/not allowed/);
  });

  // Builds and drops its own database: on Windows the drop's checkpoint fsyncs every new file (~25 s here).
  it("verify_balances() exposes a tampered running balance (rogue DBA)", async () => {
    const scratch = await scratchDatabase();
    try {
      await migrate(scratch.client, dir);
      await openAccount(scratch.client, { code: "x:bank", kind: "asset", asset: "PKR", allowOverdraft: true });
      await openAccount(scratch.client, { code: "x:alice", kind: "liability", asset: "PKR" });
      await postJournal(scratch.client, {
        idempotencyKey: "tamper-balance-1",
        kind: "deposit",
        createdBy: "t",
        postings: [
          { account: "x:bank", amount: 100n },
          { account: "x:alice", amount: -100n },
        ],
      });
      await scratch.client.query("ALTER TABLE ledger.account_balances DISABLE TRIGGER account_balances_forward_only");
      await scratch.client.query("UPDATE ledger.account_balances SET balance = -1000000 WHERE account_id = (SELECT id FROM ledger.accounts WHERE code = 'x:alice')");
      await scratch.client.query("ALTER TABLE ledger.account_balances ENABLE TRIGGER account_balances_forward_only");
      const { rows } = await scratch.client.query<{ code: string; cached: string; actual: string }>(
        "SELECT code, cached::text, actual::text FROM ledger.verify_balances()",
      );
      expect(rows).toEqual([{ code: "x:alice", cached: "-1000000", actual: "-100" }]);
    } finally {
      await scratch.drop();
    }
  }, 120_000);

  it("write cost no longer grows with account history", async () => {
    await openAccount(db, { code: "perf:hot", kind: "asset", asset: "PKR", allowOverdraft: true });
    await openAccount(db, { code: "perf:other", kind: "asset", asset: "PKR", allowOverdraft: true });
    // Median per journal, so a checkpoint or another process stalling the disk for a moment does
    // not decide the result; growth with history moves the median, a stall does not.
    const timeBatch = async (count: number): Promise<number> => {
      const times: number[] = [];
      for (let i = 0; i < count; i++) {
        const t0 = performance.now();
        await transfer("perf:other", "perf:hot", 1n, "perf");
        times.push(performance.now() - t0);
      }
      return times.sort((x, y) => x - y)[Math.floor(count / 2)] ?? 0;
    };
    const early = await timeBatch(200);
    for (let i = 0; i < 1_600; i++) await transfer("perf:other", "perf:hot", 1n, "perf-fill");
    const late = await timeBatch(200);
    // With the old full-history sum the late batch was several times slower; allow noise, not growth.
    expect(late / early).toBeLessThan(2);
    expect(await verifyBalances()).toEqual([]);
  }, 300_000);
});

describe("RF-3 missing posting fields", () => {
  it("rejects postings with a missing account or amount in validation, not later", async () => {
    for (const postings of [
      [{ amount: "100" }, { account: "income:rent", amount: "-100" }],
      [{ account: "bank:escrow" }, { account: "income:rent", amount: "-100" }],
      [{ account: "bank:escrow", amount: null }, { account: "income:rent", amount: "-100" }],
    ]) {
      await expect(
        db.query("SELECT ledger.post_journal($1, 'bad_shape', null, null, 'test', $2::jsonb)", [key("shape"), JSON.stringify(postings)]),
      ).rejects.toThrow(/malformed posting/);
    }
    await expect(db.query("SELECT ledger.post_journal($1, 'bad_shape', null, null, 'test', NULL)", [key("null")])).rejects.toThrow(
      /at least two postings/,
    );
  });
});
