import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChainMismatchError, HaltedError, Indexer } from "../src/indexer.ts";
import { FakeChain, fakeDeployment } from "./fake-chain.ts";
import { indexerPool, migratedDatabase } from "./helpers.ts";
import { scenario } from "./scenario.ts";

/**
 * QBFT has immediate finality, so a block never changes once seen. Whenever the node's chain does
 * not match what was indexed, the indexer must HALT (fail closed), record why, and refuse to go on
 * until an operator clears it. Each test gets its own database and chain.
 */
let admin: pg.Client;
let pool: pg.Pool;
let dropPool: () => Promise<void>;
let drop: () => Promise<void>;
let chain: FakeChain;

beforeEach(async () => {
  let settings: pg.ClientConfig;
  ({ admin, settings, drop } = await migratedDatabase());
  ({ pool, drop: dropPool } = await indexerPool(settings, 4));
  chain = new FakeChain();
});

afterEach(async () => {
  await dropPool();
  await drop();
});

const mints = (salt: string) => scenario([{ kind: 0, a: 1, b: 0, amount: 5 }, { kind: 1, a: 1, b: 2, amount: 2 }], salt);

async function setup(): Promise<{ ix: Indexer; halts: Error[]; d: ReturnType<typeof fakeDeployment> }> {
  chain.mineEmpty(3);
  const d = fakeDeployment(chain.tip + 1n);
  for (const tx of mints("a")) chain.mine(d, tx);
  chain.mineEmpty(2);
  const halts: Error[] = [];
  const ix = new Indexer(pool, chain, d, { windowBlocks: 2, onHalt: (e) => halts.push(e) });
  await ix.register();
  await ix.catchUp();
  return { ix, halts, d };
}

async function haltReason(id: string): Promise<string | null> {
  const { rows } = await admin.query<{ halt_reason: string | null }>("SELECT halt_reason FROM chain.cursors WHERE deployment = $1", [id]);
  return rows[0]?.halt_reason ?? null;
}

describe("halts on any chain mismatch", () => {
  it("history rewritten below the cursor: the next batch does not link, so the indexer halts", async () => {
    const { ix, d } = await setup();
    const before = await ix.cursor();
    chain.rewrite(before.blockNumber - 1n);
    chain.mineEmpty(1);
    await expect(ix.runOnce()).rejects.toBeInstanceOf(ChainMismatchError);
    expect(await haltReason(d.id)).toMatch(/ChainMismatchError: block \d+ names parent/);
    expect((await ix.cursor()).blockNumber).toBe(before.blockNumber);
    await expect(ix.runOnce()).rejects.toBeInstanceOf(HaltedError);
  });

  it("the indexed tip itself replaced while idle: detected without waiting for new blocks", async () => {
    const { ix, d } = await setup();
    chain.rewrite(chain.tip);
    await expect(ix.runOnce()).rejects.toBeInstanceOf(ChainMismatchError);
    expect(await haltReason(d.id)).toMatch(/was indexed as/);
  });

  it("a header inside the window that does not link to the one before", async () => {
    const { ix, d } = await setup();
    chain.mineEmpty(3);
    const target = chain.tip - 1n;
    chain.corruptHeader = (h) => (h.number === target ? { ...h, parentHash: `0x${"66".repeat(32)}` } : h);
    const before = await ix.cursor();
    await expect(ix.catchUp()).rejects.toBeInstanceOf(ChainMismatchError);
    expect((await ix.cursor()).blockNumber).toBeLessThan(target);
    expect((await ix.cursor()).blockNumber).toBeGreaterThanOrEqual(before.blockNumber);
    expect(await haltReason(d.id)).toContain(`block ${target.toString()} names parent`);
  });

  it("a log whose block hash is not the header's", async () => {
    const { ix, d } = await setup();
    for (const tx of mints("b")) chain.mine(d, tx);
    chain.corruptLog = (l) => ({ ...l, blockHash: `0x${"99".repeat(32)}` });
    await expect(ix.catchUp()).rejects.toBeInstanceOf(ChainMismatchError);
    expect(await haltReason(d.id)).toMatch(/log at block \d+ log \d+ has block hash/);
  });

  it("a node on another chain ID is refused before anything is read", async () => {
    const d = fakeDeployment(1n, 586_586);
    const other = new FakeChain(1337);
    other.mineEmpty(2);
    await expect(new Indexer(pool, other, d).register()).rejects.toBeInstanceOf(ChainMismatchError);
    const { rows } = await admin.query("SELECT 1 FROM chain.deployments");
    expect(rows).toHaveLength(0);
  });

  it("follow mode stops on a halt and raises the alert once; an administrator can clear it after investigation", async () => {
    const { ix, d, halts } = await setup();
    const listener = await pool.connect();
    const alerts: string[] = [];
    listener.on("notification", (m) => alerts.push(m.payload ?? ""));
    await listener.query("LISTEN chain_alert");
    try {
      chain.rewrite(chain.tip - 2n);
      chain.mineEmpty(1);
      const follower = new Indexer(pool, chain, d, { pollMs: 20, onHalt: (e) => halts.push(e) });
      await follower.start();
      const started = Date.now();
      while (follower.running && Date.now() - started < 3_000) await new Promise((r) => setTimeout(r, 20));
      expect(follower.running).toBe(false);
      await follower.stop();
      expect(halts).toHaveLength(1);
      expect(halts[0]).toBeInstanceOf(ChainMismatchError);
      await new Promise((r) => setTimeout(r, 50));
      expect(alerts.map((a) => (JSON.parse(a) as { deployment: string }).deployment)).toEqual([d.id]);
    } finally {
      await listener.query("UNLISTEN chain_alert");
      listener.release();
    }

    // An administrator decides the old history was right (here: the test puts it back) and clears the halt.
    await admin.query("SELECT chain.clear_halt($1, 'ops-lead', 'node pointed at a stale snapshot; fixed')", [d.id]);
    await expect(ix.runOnce()).rejects.toBeInstanceOf(ChainMismatchError); // still wrong: halts again
  });
});
