import fc from "fast-check";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnchorAlarm, Anchorer, type AnchorerOptions, type CrashPoint, type RunResult } from "../src/anchorer.ts";
import { anchorsOf } from "../src/store.ts";
import { verifyAnchors, type VerifyReport } from "../src/verify.ts";
import { FakeAnchorChain, FakeBesu, memoryKeys } from "./fakes.ts";
import { migratedDatabase, postJournals, rehashLedgerAfterEdit } from "./helpers.ts";

class Crash extends Error {}

interface World {
  chain: FakeAnchorChain;
  besu: FakeBesu;
  keys: ReturnType<typeof memoryKeys>;
  job: (opts?: Partial<AnchorerOptions>) => Anchorer;
  verify: () => Promise<VerifyReport>;
}

function world(pool: pg.Pool): World {
  const keys = memoryKeys();
  const chain = new FakeAnchorChain(keys.address("anchor"));
  const besu = new FakeBesu();
  const target = { anchorChainId: chain.id, contract: chain.contract };
  return {
    chain,
    besu,
    keys,
    job: (opts = {}) =>
      new Anchorer(pool, chain, besu, { target, besuChainId: besu.id, keys, keyRef: "anchor", custody: "dev-file", actor: "test", receiptWaitMs: 20, pollMs: 1, ...opts }),
    verify: () => verifyAnchors(pool, chain, besu, { target, besuChainId: besu.id, fromBlock: 0n, logWindow: 1n }),
  };
}

function crashAt(point: CrashPoint): AnchorerOptions["hooks"] {
  return {
    at: (p) => {
      if (p === point) throw new Crash(`crash at ${p}`);
    },
  };
}

async function expectAlarm(p: Promise<unknown>, pattern: RegExp): Promise<void> {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof AnchorAlarm && pattern.test(e.message));
}

describe("anchoring job on a fake public chain", () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    ({ pool, drop } = await migratedDatabase());
    await postJournals(pool, 3);
  });

  afterAll(async () => {
    await drop();
  });

  it("anchors the private head and the ledger head, skips when nothing is new, and verifies", async () => {
    const w = world(pool);
    const first = await w.job().runOnce();
    expect(first).toMatchObject({ action: "anchored", besuBlock: 100n });
    expect(await w.job().runOnce()).toMatchObject({ action: "skipped" });
    w.besu.height = 160n;
    await postJournals(pool, 2);
    expect(await w.job().runOnce()).toMatchObject({ action: "anchored", besuBlock: 160n });
    expect(w.chain.events.map((e) => e.besuBlock)).toEqual([100n, 160n]);
    const records = await anchorsOf(pool, { anchorChainId: w.chain.id, contract: w.chain.contract });
    expect(records.map((r) => r.status)).toEqual(["confirmed", "confirmed"]);
    expect(records[1]?.ledgerJournalId).toBeGreaterThan(records[0]?.ledgerJournalId ?? 0n);
    const report = await w.verify();
    expect(report).toMatchObject({ ok: true, anchors: 2, records: 2 });
    expect(report.scanned.windows).toBeGreaterThan(1); // 1-block log windows
  });

  it("stays behind the private head by the configured confirmations", async () => {
    const w = world(pool);
    expect(await w.job({ besuConfirmations: 5n }).runOnce()).toMatchObject({ action: "anchored", besuBlock: 95n });
  });

  it.each<CrashPoint>(["recorded", "signed", "sent-recorded", "broadcast"])("recovers from a crash at %s without a second anchor", async (point) => {
    const w = world(pool);
    await expect(w.job({ hooks: crashAt(point) }).runOnce()).rejects.toBeInstanceOf(Crash);
    const r = await w.job().runOnce();
    expect(r).toMatchObject({ action: "anchored", besuBlock: 100n });
    expect(w.chain.events).toHaveLength(1);
    expect(w.chain.reverted).toBe(0);
    expect((await w.verify()).ok).toBe(true);
  });

  it("re-broadcasts the SAME signed transaction when the broadcast was lost", async () => {
    const w = world(pool);
    w.chain.loseBroadcast = true;
    const first = await w.job().runOnce();
    expect(first.action).toBe("pending");
    const [open] = await anchorsOf(pool, { anchorChainId: w.chain.id, contract: w.chain.contract });
    const r = await w.job().runOnce();
    expect(r).toMatchObject({ action: "anchored", txHash: open?.tx?.hash });
  });

  it("treats a lost response like any other unknown outcome and decides from the chain", async () => {
    const w = world(pool);
    w.chain.loseResponse = true;
    expect(await w.job().runOnce()).toMatchObject({ action: "anchored" });
    expect(w.chain.events).toHaveLength(1);
  });

  it("re-signs only when the nonce was provably used by another transaction", async () => {
    const w = world(pool);
    w.chain.automine = false;
    expect((await w.job().runOnce()).action).toBe("pending");
    const [open] = await anchorsOf(pool, { anchorChainId: w.chain.id, contract: w.chain.contract });
    w.chain.consumeNonce(w.keys.address("anchor")); // our transaction can never be mined now
    w.chain.automine = true;
    const r = await w.job().runOnce();
    expect(r.action).toBe("anchored");
    expect(r.action === "anchored" && r.txHash).not.toBe(open?.tx?.hash);
    const history = await pool.query<{ action: string }>("SELECT action FROM anchor.history WHERE anchor_id = $1 ORDER BY id", [open?.id.toString()]);
    expect(history.rows.map((x) => x.action)).toEqual(["record", "sent", "dropped", "sent", "confirm"]);
  });

  it("waits while the transaction is in the pool and for anchor-chain confirmations", async () => {
    const w = world(pool);
    w.chain.automine = false;
    expect(await w.job({ confirmations: 2n }).runOnce()).toMatchObject({ action: "pending", reason: expect.stringMatching(/pool/) as unknown });
    w.chain.mine();
    expect(await w.job({ confirmations: 2n }).runOnce()).toMatchObject({ action: "pending", reason: expect.stringMatching(/confirmations/) as unknown });
    w.chain.mine();
    w.chain.mine();
    expect(await w.job({ confirmations: 2n }).runOnce()).toMatchObject({ action: "anchored" });
  });

  it("sends nothing while the gas price is above the cap", async () => {
    const w = world(pool);
    w.chain.gasPriceWei = 10n ** 12n;
    expect(await w.job({ maxGasPriceWei: 10n ** 10n }).runOnce()).toMatchObject({ action: "pending", reason: expect.stringMatching(/cap/) as unknown });
    expect(w.chain.events).toHaveLength(0);
    w.chain.gasPriceWei = 10n ** 9n;
    expect(await w.job({ maxGasPriceWei: 10n ** 10n }).runOnce()).toMatchObject({ action: "anchored" });
  });

  it("lets only one process anchor a contract at a time", async () => {
    const w = world(pool);
    const results = await Promise.all([w.job().runOnce(), w.job().runOnce(), w.job().runOnce()]);
    const actions = results.map((r) => r.action).sort();
    expect(actions.filter((a) => a === "anchored")).toHaveLength(1);
    expect(actions.every((a) => a === "anchored" || a === "busy" || a === "skipped")).toBe(true);
    expect(w.chain.events).toHaveLength(1);
  });

  it("fails closed on a rotated key, a missing contract, wrong chains or the dev chain", async () => {
    const w = world(pool);
    w.chain.anchorKey = `0x${"99".repeat(20)}`;
    await expectAlarm(w.job().runOnce(), /rotated/);
    const v = world(pool);
    v.chain.codeless = true;
    await expectAlarm(v.job().runOnce(), /no contract/);
    const u = world(pool);
    await expect(u.job({ besuChainId: 1 }).runOnce()).rejects.toThrow(/private RPC serves chain 586586/);
    await expect(u.job({ target: { anchorChainId: 8453, contract: u.chain.contract } }).runOnce()).rejects.toThrow(/serves chain 586650/);
    const prod = world(pool);
    await expectAlarm(prod.job({ production: true }).runOnce(), /production/);
    const dev = new FakeAnchorChain(w.keys.address("anchor"), 586_586);
    const job = new Anchorer(pool, dev, new FakeBesu(586_586), {
      target: { anchorChainId: 586_586, contract: dev.contract }, besuChainId: 586_586, keys: w.keys, keyRef: "anchor", custody: "dev-file", actor: "t",
    });
    await expectAlarm(job.runOnce(), /586586/);
  });

  it("refuses to continue after an anchor it did not write (stolen key) and alarms on a revert", async () => {
    const w = world(pool);
    await w.job().runOnce();
    w.chain.rogueAnchor(150n, `0x${"77".repeat(32)}`);
    w.besu.height = 200n;
    await expectAlarm(w.job().runOnce(), /last anchored block is 150, the database's is 100/);
    const report = await w.verify();
    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toMatch(/private block 150 .*no database record/);

    // A rogue anchor that lands between our record and our send: the contract refuses ours.
    const v = world(pool);
    await expect(v.job({ hooks: crashAt("recorded") }).runOnce()).rejects.toBeInstanceOf(Crash);
    v.chain.rogueAnchor(120n, `0x${"66".repeat(32)}`);
    await expectAlarm(v.job().runOnce(), /refuses block 100: NotIncreasing/);
    const [rec] = await anchorsOf(pool, { anchorChainId: v.chain.id, contract: v.chain.contract });
    expect(rec).toMatchObject({ status: "failed" });
  });

  it("property: random crashes, RPC faults, lost broadcasts and races never double-anchor, never go lower and never skip silently", async () => {
    type Step =
      | { kind: "advance"; blocks: number; journals: number }
      | { kind: "run"; crash: CrashPoint | null; failCalls: number; lose: "none" | "broadcast" | "response"; automine: boolean; racers: number }
      | { kind: "mine" };
    const step: fc.Arbitrary<Step> = fc.oneof(
      fc.record({ kind: fc.constant("advance" as const), blocks: fc.integer({ min: 0, max: 30 }), journals: fc.integer({ min: 0, max: 2 }) }),
      fc.record({
        kind: fc.constant("run" as const),
        crash: fc.constantFrom<CrashPoint | null>(null, null, "recorded", "signed", "sent-recorded", "broadcast"),
        failCalls: fc.constantFrom(0, 0, 0, 1, 3, 6, 9),
        lose: fc.constantFrom("none" as const, "none" as const, "broadcast" as const, "response" as const),
        automine: fc.boolean(),
        racers: fc.constantFrom(1, 1, 2),
      }),
      fc.record({ kind: fc.constant("mine" as const) }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 12 }), async (steps) => {
        const w = world(pool);
        for (const s of steps) {
          if (s.kind === "advance") {
            w.besu.height += BigInt(s.blocks);
            if (s.journals) await postJournals(pool, s.journals);
          } else if (s.kind === "mine") {
            w.chain.mine();
          } else {
            w.chain.automine = s.automine;
            w.chain.failCalls = s.failCalls;
            w.chain.loseBroadcast = s.lose === "broadcast";
            w.chain.loseResponse = s.lose === "response";
            const jobs = Array.from({ length: s.racers }, (_, i) => w.job(i === 0 && s.crash ? { hooks: crashAt(s.crash) } : {}));
            const results = await Promise.allSettled(jobs.map((j) => j.runOnce()));
            for (const r of results) if (r.status === "rejected" && r.reason instanceof AnchorAlarm) throw r.reason;
            w.chain.failCalls = 0;
            w.chain.loseBroadcast = false;
            w.chain.loseResponse = false;
          }
        }
        // Settle: a healthy chain, the job runs until nothing is open.
        w.chain.automine = true;
        w.chain.mine();
        let last: RunResult | null = null;
        for (let i = 0; i < 4; i++) {
          last = await w.job().runOnce();
          if (last.action === "skipped") break;
        }
        expect(last?.action).toBe("skipped");

        const target = { anchorChainId: w.chain.id, contract: w.chain.contract };
        const records = await anchorsOf(pool, target);
        const confirmed = records.filter((r) => r.status === "confirmed");
        // never skip silently: nothing failed, nothing left open
        expect(records.filter((r) => r.status !== "confirmed")).toEqual([]);
        // never double-anchor: one successful transaction per record, none reverted
        expect(w.chain.reverted).toBe(0);
        expect(w.chain.successesBy.get(w.keys.address("anchor")) ?? 0).toBe(confirmed.length);
        // never lower: strictly increasing, and exactly the recorded commitments in the recorded transactions
        const blocks = w.chain.events.map((e) => e.besuBlock);
        expect(blocks).toEqual([...blocks].sort((a, b) => (a < b ? -1 : 1)));
        expect(new Set(blocks).size).toBe(blocks.length);
        expect(w.chain.events.map((e) => [e.besuBlock, e.commitment, e.txHash])).toEqual(confirmed.map((r) => [r.besuBlock, r.commitment, r.tx?.hash]));
        expect(blocks.length).toBeGreaterThan(0);
        expect((await w.verify()).problems).toEqual([]);
      }),
      { numRuns: 60 },
    );
  }, 240_000);
});

describe("verify detects tampering (threats CH-1 and D-1)", () => {
  let pool: pg.Pool;
  let admin: pg.Client;
  let drop: () => Promise<void>;
  let w: World;
  let anchoredJournal: bigint;

  beforeAll(async () => {
    ({ pool, admin, drop } = await migratedDatabase());
    await postJournals(pool, 4);
    w = world(pool);
    await w.job().runOnce();
    w.besu.height = 130n;
    anchoredJournal = await postJournals(pool, 2);
    await w.job().runOnce();
    await postJournals(pool, 1); // not anchored yet
    expect((await w.verify()).ok).toBe(true);
  });

  afterAll(async () => {
    await drop();
  });

  it("a rewritten private block (colluding validators)", async () => {
    w.besu.rewrite(100n);
    const r = await w.verify();
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([expect.stringMatching(/private block 100 .*PRIVATE CHAIN REWRITTEN/)]);
  });

  it("an edited anchor record (rogue DBA hides the change)", async () => {
    await admin.query("BEGIN");
    await admin.query("SET LOCAL session_replication_role = replica");
    await admin.query("UPDATE anchor.anchors SET besu_block_hash = $1 WHERE besu_block = 100", [await w.besu.blockHash(100n)]);
    await admin.query("COMMIT");
    const r = await w.verify();
    expect(r.problems).toEqual([expect.stringMatching(/private block 100 .*does not hash to the public commitment/)]);
  });

  it("a ledger row edited in place, then the whole ledger re-hashed so verify_chain is clean", async () => {
    await admin.query("BEGIN");
    await admin.query("SET LOCAL session_replication_role = replica");
    await admin.query("UPDATE ledger.postings SET amount = amount * 10 WHERE journal_id = $1", [(anchoredJournal - 1n).toString()]);
    await admin.query("COMMIT");
    let r = await w.verify();
    expect(r.problems.join("\n")).toContain(`ledger journal ${(anchoredJournal - 1n).toString()}: content does not match its hash`);

    await rehashLedgerAfterEdit(admin, 2n, "nothing to see here");
    expect((await admin.query("SELECT * FROM ledger.verify_chain()")).rows).toEqual([]); // the database's own check is fooled
    r = await w.verify();
    expect(r.problems.filter((p) => /LEDGER CHANGED/.test(p))).toHaveLength(2); // both anchors expose it
    expect(r.problems.join("\n")).toContain(`journal ${anchoredJournal.toString()} now hashes to`);
  });

  it("a deleted journal and a confirmed anchor missing from the public chain", async () => {
    await admin.query("BEGIN");
    await admin.query("SET LOCAL session_replication_role = replica");
    await admin.query("DELETE FROM ledger.postings WHERE journal_id = $1", [anchoredJournal.toString()]);
    await admin.query("DELETE FROM ledger.journal WHERE id = $1", [anchoredJournal.toString()]);
    await admin.query("COMMIT");
    w.chain.events.splice(0, 1);
    const r = await w.verify();
    const text = r.problems.join("\n");
    expect(text).toContain(`anchored journal ${anchoredJournal.toString()} is missing`);
    expect(text).toMatch(/private block 100\) is confirmed but not on the public chain/);
  });
});

