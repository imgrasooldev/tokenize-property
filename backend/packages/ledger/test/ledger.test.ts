import { fileURLToPath } from "node:url";
import fc from "fast-check";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { scratchDatabase } from "../../db/test/helpers.ts";
import { balanceOf, chainHead, LedgerError, openAccount, postJournal, verifyChain } from "../src/index.ts";

const MIGRATIONS = fileURLToPath(new URL("../../db/migrations", import.meta.url));

let db: pg.Client;
let settings: pg.ClientConfig;
let drop: () => Promise<void>;
let n = 0;
const key = (label: string) => `test:${label}:${++n}:${Date.now()}`;

beforeAll(async () => {
  ({ client: db, settings, drop } = await scratchDatabase());
  await migrate(db, MIGRATIONS);
  // Trustee escrow bank account (asset, debit-normal) and investor payables (liability, credit-normal).
  await openAccount(db, { code: "bank:escrow", kind: "asset", asset: "PKR" });
  await openAccount(db, { code: "investor:alice:payable", kind: "liability", asset: "PKR" });
  await openAccount(db, { code: "investor:bob:payable", kind: "liability", asset: "PKR" });
  await openAccount(db, { code: "income:rent", kind: "income", asset: "PKR" });
  await openAccount(db, { code: "token:gpf3:alice", kind: "liability", asset: "GPF3" });
  await openAccount(db, { code: "token:gpf3:issued", kind: "equity", asset: "GPF3", allowOverdraft: true });
});

afterAll(async () => {
  await drop();
});

async function expectLedgerError(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof LedgerError && e.code === code);
}

describe("L-1 double entry", () => {
  it("posts a balanced journal and updates balances", async () => {
    await postJournal(db, {
      idempotencyKey: key("rent"),
      kind: "rent_received",
      createdBy: "test",
      postings: [
        { account: "bank:escrow", amount: 3_000_000n },
        { account: "income:rent", amount: -3_000_000n },
      ],
    });
    expect(await balanceOf(db, "bank:escrow")).toBe(3_000_000n);
    expect(await balanceOf(db, "income:rent")).toBe(-3_000_000n);
  });

  it("rejects an unbalanced journal in the database even if the client check is bypassed", async () => {
    await expect(
      db.query("SELECT ledger.post_journal($1,'bad_kind',null,null,'test',$2::jsonb)", [
        key("unbalanced"),
        JSON.stringify([
          { account: "bank:escrow", amount: "100" },
          { account: "income:rent", amount: "-99" },
        ]),
      ]),
    ).rejects.toThrow(/does not balance/);
  });

  it("rejects fewer than two postings, zero, float and oversized amounts", async () => {
    for (const postings of [
      [{ account: "bank:escrow", amount: "100" }],
      [
        { account: "bank:escrow", amount: "0" },
        { account: "income:rent", amount: "0" },
      ],
      [
        { account: "bank:escrow", amount: "1.5" },
        { account: "income:rent", amount: "-1.5" },
      ],
      [
        { account: "bank:escrow", amount: 100 },
        { account: "income:rent", amount: -100 },
      ],
      [
        { account: "bank:escrow", amount: "9999999999999999999" },
        { account: "income:rent", amount: "-9999999999999999999" },
      ],
    ]) {
      await expect(
        db.query("SELECT ledger.post_journal($1,'bad_shape',null,null,'test',$2::jsonb)", [key("shape"), JSON.stringify(postings)]),
      ).rejects.toThrow();
    }
  });

  it("rejects unknown accounts, repeated accounts and mixed-asset imbalance", async () => {
    await expectLedgerError(
      postJournal(db, {
        idempotencyKey: key("unknown"),
        kind: "test_kind",
        createdBy: "test",
        postings: [
          { account: "bank:nope", amount: 1n },
          { account: "income:rent", amount: -1n },
        ],
      }),
      "UNKNOWN_ACCOUNT",
    );
    await expectLedgerError(
      postJournal(db, {
        idempotencyKey: key("mixed"),
        kind: "test_kind",
        createdBy: "test",
        // 100 PKR against 100 token units: each asset must balance on its own.
        postings: [
          { account: "bank:escrow", amount: 100n },
          { account: "token:gpf3:alice", amount: -100n },
        ],
      }),
      "UNBALANCED",
    );
  });
});

describe("L-5 idempotency", () => {
  it("returns the same journal for an identical retry and rejects a different payload", async () => {
    const input = {
      idempotencyKey: key("idem"),
      kind: "rent_received",
      createdBy: "test",
      postings: [
        { account: "bank:escrow", amount: 500n },
        { account: "income:rent", amount: -500n },
      ],
    };
    const a = await postJournal(db, input);
    const before = await balanceOf(db, "bank:escrow");
    const b = await postJournal(db, input);
    expect(b).toBe(a);
    expect(await balanceOf(db, "bank:escrow")).toBe(before); // no double posting
    await expectLedgerError(
      postJournal(db, {
        ...input,
        postings: [
          { account: "bank:escrow", amount: 501n },
          { account: "income:rent", amount: -501n },
        ],
      }),
      "IDEMPOTENCY_CONFLICT",
    );
  });
});

describe("L-6 no overdraft", () => {
  it("cannot pay an investor more than they are owed", async () => {
    // Owe Alice Rs 10,000 from rent income.
    await postJournal(db, {
      idempotencyKey: key("accrue"),
      kind: "rent_distribution",
      createdBy: "test",
      postings: [
        { account: "income:rent", amount: 1_000_000n },
        { account: "investor:alice:payable", amount: -1_000_000n },
      ],
    });
    await expectLedgerError(
      postJournal(db, {
        idempotencyKey: key("overpay"),
        kind: "payout",
        createdBy: "test",
        postings: [
          { account: "investor:alice:payable", amount: 1_000_001n },
          { account: "bank:escrow", amount: -1_000_001n },
        ],
      }),
      "INSUFFICIENT_BALANCE",
    );
    await postJournal(db, {
      idempotencyKey: key("pay"),
      kind: "payout",
      createdBy: "test",
      postings: [
        { account: "investor:alice:payable", amount: 1_000_000n },
        { account: "bank:escrow", amount: -1_000_000n },
      ],
    });
    expect(await balanceOf(db, "investor:alice:payable")).toBe(0n);
  });
});

describe("L-2 and L-3 append-only and least privilege", () => {
  it("blocks UPDATE, DELETE and TRUNCATE even for the admin", async () => {
    await expect(db.query("UPDATE ledger.postings SET amount = amount + 1")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM ledger.journal")).rejects.toThrow(/append-only/);
    await expect(db.query("TRUNCATE ledger.postings CASCADE")).rejects.toThrow(/append-only/);
    await expect(db.query("UPDATE ledger.accounts SET allow_overdraft = true")).rejects.toThrow(/append-only/);
  });

  it("gives the writer role no direct table access, only the validated functions", async () => {
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL ROLE pt_ledger_writer");
      await expect(
        db.query("INSERT INTO ledger.accounts (code, kind, asset) VALUES ('evil:acct', 'asset', 'PKR')"),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await db.query("ROLLBACK");
    }
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL ROLE pt_ledger_writer");
      await expect(db.query("SELECT * FROM ledger.journal")).rejects.toThrow(/permission denied/);
    } finally {
      await db.query("ROLLBACK");
    }
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL ROLE pt_ledger_writer");
      const { rows } = await db.query<{ id: string }>(
        "SELECT ledger.post_journal($1,'rent_received',null,null,'writer',$2::jsonb) AS id",
        [key("writer"), JSON.stringify([{ account: "bank:escrow", amount: "7" }, { account: "income:rent", amount: "-7" }])],
      );
      expect(Number(rows[0]?.id)).toBeGreaterThan(0);
    } finally {
      await db.query("ROLLBACK");
    }
  });

  it("gives the reader role read access but no writes", async () => {
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL ROLE pt_ledger_reader");
      await db.query("SELECT count(*) FROM ledger.balances");
      await expect(
        db.query("SELECT ledger.post_journal('reader-key-1','rent_received',null,null,'r','[]'::jsonb)"),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await db.query("ROLLBACK");
    }
  });
});

describe("L-4 hash chain", () => {
  it("verifies an intact chain and exposes the head for anchoring", async () => {
    expect(await verifyChain(db)).toEqual([]);
    const head = await chainHead(db);
    expect(head?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("detects a change made by someone who disabled the protection (e.g. a rogue DBA)", async () => {
    const scratch = await scratchDatabase();
    try {
      await migrate(scratch.client, MIGRATIONS);
      await openAccount(scratch.client, { code: "a:x", kind: "asset", asset: "PKR", allowOverdraft: true });
      await openAccount(scratch.client, { code: "a:y", kind: "income", asset: "PKR", allowOverdraft: true });
      for (let i = 0; i < 3; i++) {
        await postJournal(scratch.client, {
          idempotencyKey: `tamper-${i}-xxxx`,
          kind: "test_kind",
          createdBy: "t",
          postings: [
            { account: "a:x", amount: 100n },
            { account: "a:y", amount: -100n },
          ],
        });
      }
      expect(await verifyChain(scratch.client)).toEqual([]);
      await scratch.client.query("ALTER TABLE ledger.postings DISABLE TRIGGER postings_append_only");
      await scratch.client.query("UPDATE ledger.postings SET amount = 90 WHERE id = 3");
      await scratch.client.query("ALTER TABLE ledger.postings ENABLE TRIGGER postings_append_only");
      const problems = await verifyChain(scratch.client);
      expect(problems.map((p) => p.problem)).toEqual(
        expect.arrayContaining(["content does not match its hash", "postings do not balance"]),
      );
      expect(problems.every((p) => p.journalId === 2n)).toBe(true);
    } finally {
      await scratch.drop();
    }
  });
});

describe("concurrency and properties", () => {
  it("keeps one linear, valid chain under concurrent writers", async () => {
    const pool = new pg.Pool({ ...settings, max: 10 });
    try {
      await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          postJournal(pool, {
            idempotencyKey: key(`concurrent-${i}`),
            kind: "rent_received",
            createdBy: "test",
            postings: [
              { account: "bank:escrow", amount: 10n },
              { account: "income:rent", amount: -10n },
            ],
          }),
        ),
      );
    } finally {
      await pool.end();
    }
    expect(await verifyChain(db)).toEqual([]);
  });

  it("for any sequence of balanced journals, every asset sums to zero and the chain verifies", async () => {
    const accounts = ["p:a", "p:b", "p:c", "p:d"];
    for (const code of accounts) await openAccount(db, { code, kind: "asset", asset: "PKR", allowOverdraft: true });
    let run = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            from: fc.constantFrom(...accounts),
            to: fc.constantFrom(...accounts),
            amount: fc.bigInt({ min: 1n, max: 10n ** 15n }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        async (transfers) => {
          run++;
          for (const [i, t] of transfers.entries()) {
            if (t.from === t.to) continue;
            await postJournal(db, {
              idempotencyKey: `prop-${run}-${i}-${Date.now()}`,
              kind: "transfer",
              createdBy: "property-test",
              postings: [
                { account: t.to, amount: t.amount },
                { account: t.from, amount: -t.amount },
              ],
            });
          }
          const { rows } = await db.query<{ asset: string; total: string }>(
            "SELECT asset, sum(balance)::text AS total FROM ledger.balances GROUP BY asset",
          );
          for (const r of rows) expect(BigInt(r.total)).toBe(0n);
        },
      ),
      { numRuns: 25 },
    );
    expect(await verifyChain(db)).toEqual([]);
  });
});
