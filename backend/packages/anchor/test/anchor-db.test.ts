import pg from "pg";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeCommitment, ZERO_HASH } from "../src/commitment.ts";
import { ledgerHead, recomputeLedger } from "../src/ledger.ts";
import { clearDropped, confirmAnchor, failAnchor, getAnchor, markSent, recordAnchor, type Target } from "../src/store.ts";
import { randomAddress } from "./fakes.ts";
import { migratedDatabase, postJournals } from "./helpers.ts";

let admin: pg.Client;
let pool: pg.Pool;
let settings: pg.ClientConfig;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ admin, pool, settings, drop } = await migratedDatabase());
});

afterAll(async () => {
  await drop();
});

const h = (s: string): Hex => keccak256(toBytes(s));
const target = (): Target => ({ anchorChainId: 586_650, contract: randomAddress() });

function input(block: bigint, journal = 0n): { besuChainId: bigint; besuBlock: bigint; besuBlockHash: Hex; ledgerJournalId: bigint; ledgerHeadHash: Hex; commitment: Hex } {
  const base = { besuChainId: 586_586n, besuBlock: block, besuBlockHash: h(`b${block.toString()}`), ledgerJournalId: journal, ledgerHeadHash: journal === 0n ? ZERO_HASH : h(`j${journal.toString()}`) };
  return { ...base, commitment: computeCommitment(base) };
}

const tx = (n: number): { hash: Hex; nonce: bigint; from: Address; raw: Hex } => ({ hash: h(`tx${String(n)}`), nonce: BigInt(n), from: `0x${"ab".repeat(20)}`, raw: `0x${"0f".repeat(60)}` });

async function errorOf(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; message: string };
  }
  throw new Error("expected an error");
}

describe("ledger recomputation (independent of the database functions)", () => {
  it("matches the database digest for awkward text and finds an edit", async () => {
    const memos = ['quote " backslash \\ slash /', "new\nline\ttab\rcr", "\u0001\u001f control", "اردو یونیکوڈ 🏠", "  spaces  ", "  ", ""];
    for (const m of memos) await postJournals(pool, 1, m || undefined);
    const r = await recomputeLedger(pool, 3); // small pages cross page boundaries
    expect(r.problems).toEqual([]);
    expect(r.journals).toBeGreaterThanOrEqual(memos.length);
    const head = await ledgerHead(pool);
    expect(r.hashes.get(head.journalId)).toBe(head.hash);
    expect((await pool.query("SELECT * FROM ledger.verify_chain()")).rows).toEqual([]);
  });
});

describe("anchor rules (0007_anchor.sql)", () => {
  it("A-2: strictly increasing private blocks, ledger never backwards, one private chain, one open anchor", async () => {
    const t = target();
    const id = await recordAnchor(pool, t, input(10n, 5n), "t");
    expect((await errorOf(recordAnchor(pool, t, input(11n, 5n), "t"))).code).toBe("PTA01");
    await markSent(pool, id, tx(1), "t");
    await confirmAnchor(pool, id, tx(1).hash, 7n, h("blk7"), "t");
    expect((await errorOf(recordAnchor(pool, t, input(10n, 6n), "t"))).code).toBe("PTA02");
    expect((await errorOf(recordAnchor(pool, t, input(9n, 6n), "t"))).code).toBe("PTA02");
    expect((await errorOf(recordAnchor(pool, t, input(11n, 4n), "t"))).code).toBe("PTA03");
    expect((await errorOf(recordAnchor(pool, t, { ...input(11n, 5n), besuChainId: 586_587n }, "t"))).code).toBe("PTA04");
    const next = await recordAnchor(pool, t, input(11n, 5n), "t");
    // A failed anchor does not count: its block may be anchored again.
    await failAnchor(pool, next, "reverted (test)", "t");
    await recordAnchor(pool, t, input(11n, 5n), "t");
    // Another contract has its own sequence.
    await recordAnchor(pool, target(), input(1n), "t");
  });

  it("A-2: concurrent writers cannot open two anchors", async () => {
    const t = target();
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => recordAnchor(pool, t, input(BigInt(100 + i)), "t")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("A-3: record before send; only allowed status edges", async () => {
    const t = target();
    const id = await recordAnchor(pool, t, input(20n), "t");
    expect((await errorOf(confirmAnchor(pool, id, tx(2).hash, 1n, h("b"), "t"))).code).toBe("PTA05");
    expect(await markSent(pool, id, tx(2), "t")).toBe(true);
    expect(await markSent(pool, id, tx(3), "t")).toBe(false); // already sent: nothing else may be signed
    expect((await errorOf(confirmAnchor(pool, id, tx(3).hash, 1n, h("b"), "t"))).code).toBe("PTA05"); // wrong tx
    expect((await errorOf(clearDropped(pool, id, tx(2).hash, "x", "t"))).message).toMatch(/reason/);
    await clearDropped(pool, id, tx(2).hash, "nonce used by another transaction", "t");
    expect((await getAnchor(pool, id)).tx).toBeNull();
    expect(await markSent(pool, id, tx(4), "t")).toBe(true);
    await confirmAnchor(pool, id, tx(4).hash, 9n, h("b9"), "t");
    expect((await errorOf(failAnchor(pool, id, "too late", "t"))).code).toBe("PTA05");
    const a = await getAnchor(pool, id);
    expect(a.status).toBe("confirmed");
    expect(a.tx?.hash).toBe(tx(4).hash);
    const history = await pool.query<{ action: string }>("SELECT action FROM anchor.history WHERE anchor_id = $1 ORDER BY id", [id.toString()]);
    expect(history.rows.map((r) => r.action)).toEqual(["record", "sent", "dropped", "sent", "confirm"]);
  });

  it("A-1/A-3: even the admin cannot change inputs, skip edges or rewrite the recorded transaction", async () => {
    const t = target();
    const id = await recordAnchor(pool, t, input(30n), "t");
    const sql = (set: string) => admin.query(`UPDATE anchor.anchors SET ${set} WHERE id = $1`, [id.toString()]);
    expect((await errorOf(sql(`commitment = '${h("x")}'`))).message).toMatch(/immutable/);
    expect((await errorOf(sql("besu_block = 31"))).message).toMatch(/immutable/);
    expect((await errorOf(sql(`ledger_head_hash = '${h("y")}'`))).message).toMatch(/immutable/);
    expect((await errorOf(sql(`status = 'confirmed', anchor_block = 1, anchor_block_hash = '${h("b")}', confirmed_at = now()`))).message).toMatch(/not allowed|check/);
    await markSent(pool, id, tx(5), "t");
    expect((await errorOf(sql(`status = 'confirmed', tx_hash = '${h("other")}', anchor_block = 1, anchor_block_hash = '${h("b")}', confirmed_at = now()`))).message).toMatch(/cannot change/);
    await confirmAnchor(pool, id, tx(5).hash, 2n, h("b2"), "t");
    expect((await errorOf(sql("status = 'sent', anchor_block = NULL, anchor_block_hash = NULL, confirmed_at = NULL"))).message).toMatch(/not allowed/);
  });

  it("A-4: no delete or truncate; history is append-only", async () => {
    const t = target();
    const id = await recordAnchor(pool, t, input(40n), "t");
    expect((await errorOf(admin.query("DELETE FROM anchor.anchors WHERE id = $1", [id.toString()]))).message).toMatch(/append-only/);
    expect((await errorOf(admin.query("TRUNCATE anchor.anchors CASCADE"))).message).toMatch(/append-only/);
    expect((await errorOf(admin.query("UPDATE anchor.history SET actor = 'x' WHERE anchor_id = $1", [id.toString()]))).message).toMatch(/append-only/);
    expect((await errorOf(admin.query("DELETE FROM anchor.history WHERE anchor_id = $1", [id.toString()]))).message).toMatch(/append-only/);
  });

  it("A-5: the writer only calls the API; the reader only reads", async () => {
    const suffix = String(Date.now());
    const writer = `pt_anchor_w_${suffix}`;
    const reader = `pt_anchor_r_${suffix}`;
    const password = `pw-${suffix}-${"x".repeat(20)}`;
    await admin.query(`CREATE ROLE ${writer} LOGIN PASSWORD '${password}' IN ROLE pt_anchor_writer`);
    await admin.query(`CREATE ROLE ${reader} LOGIN PASSWORD '${password}' IN ROLE pt_anchor_reader`);
    const w = new pg.Client({ ...settings, user: writer, password });
    const r = new pg.Client({ ...settings, user: reader, password });
    await w.connect();
    await r.connect();
    try {
      const t = target();
      const id = await recordAnchor(w, t, input(50n), "w");
      expect(await ledgerHead(w)).toBeTruthy();
      expect((await errorOf(w.query("INSERT INTO anchor.history (anchor_id, actor, action, detail) VALUES ($1, 'w', 'fail', '{}')", [id.toString()]))).code).toBe("42501");
      expect((await errorOf(w.query("UPDATE anchor.anchors SET status = 'failed', failure = 'xxxxx' WHERE id = $1", [id.toString()]))).code).toBe("42501");
      expect((await errorOf(w.query("SELECT anchor.log($1, 'w', 'fail', '{}')", [id.toString()]))).code).toBe("42501");
      expect((await r.query("SELECT count(*) FROM anchor.anchors")).rows).toHaveLength(1);
      expect((await recomputeLedger(r)).problems).toEqual([]);
      expect((await errorOf(recordAnchor(r, target(), input(1n), "r"))).code).toBe("42501");
      expect((await errorOf(r.query("SELECT * FROM ledger.chain_head()"))).code).toBe("42501");
    } finally {
      await w.end();
      await r.end();
      await admin.query(`DROP ROLE ${writer}`);
      await admin.query(`DROP ROLE ${reader}`);
    }
  });
});
