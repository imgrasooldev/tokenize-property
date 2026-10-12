import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { issuanceGuardAbi, tokenAbi } from "@pt/contracts";
import { openAccount, postJournal } from "@pt/ledger";
import pg from "pg";
import { createPublicClient, http } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { scratchDatabase } from "../../db/test/helpers.ts";
import { demoAddresses, latestDeployment } from "../../demo-console/src/local.ts";
import { enqueue, getCommand, OutboxWorker } from "../src/index.ts";
import { localMintExecutor, pgSignerLock } from "../src/local-executor.ts";

/**
 * End to end on the real local Besu network: a ledger entry and its mint command commit together,
 * a worker mints through IssuanceGuard, and a second command reusing the refId is refused before
 * anything is sent. Skipped when the network is not running (as in CI).
 */
const MIGRATIONS = fileURLToPath(new URL("../../db/migrations", import.meta.url));
const RPC = "http://127.0.0.1:8545";

async function chainUp(): Promise<boolean> {
  try {
    const id = await createPublicClient({ transport: http(RPC, { timeout: 2_000 }) }).getChainId();
    return id === 586_586 && latestDeployment() !== null;
  } catch {
    return false;
  }
}
const up = await chainUp();

describe.skipIf(!up)("outbox on the local chain", () => {
  let admin: pg.Client;
  let settings: pg.ClientConfig;
  let pool: pg.Pool;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    ({ client: admin, settings, drop } = await scratchDatabase());
    await migrate(admin, MIGRATIONS);
    pool = new pg.Pool({ ...settings, max: 10 });
  });

  afterAll(async () => {
    await pool.end();
    await drop();
  });

  it("commits the ledger entry and the mint command together, then mints exactly once", async () => {
    const d = latestDeployment();
    const alice = demoAddresses().get("ALICE");
    if (!d || !alice) throw new Error("no deployment");
    const client = createPublicClient({ transport: http(RPC) });
    const before = await client.readContract({ address: d.token, abi: tokenAbi, functionName: "balanceOf", args: [alice] });
    const refId = `0x${randomBytes(32).toString("hex")}` as const;
    const payload = { issuance: d.issuance, to: alice, amount: "7", refId };

    // Business transaction: money recorded and command queued atomically.
    const c = await pool.connect();
    let id: bigint;
    try {
      await c.query("BEGIN");
      await openAccount(c, { code: "bank:subscriptions", kind: "asset", asset: "PKR" });
      await openAccount(c, { code: "investor:alice:subscription", kind: "liability", asset: "PKR" });
      await postJournal(c, {
        idempotencyKey: `sub:${refId}:paid`,
        kind: "subscription_paid",
        createdBy: "test",
        postings: [
          { account: "bank:subscriptions", amount: 350_000n },
          { account: "investor:alice:subscription", amount: -350_000n },
        ],
      });
      id = await enqueue(c, { idempotencyKey: `mint:${refId}`, kind: "issuance.mint", payload, ref: `sub:${refId}`, createdBy: "test" });
      await c.query("COMMIT");
    } finally {
      c.release();
    }

    const lock = pgSignerLock(settings);
    const worker = new OutboxWorker(pool, {
      workerId: "chain-test",
      executors: { "issuance.mint": localMintExecutor({ rpcUrl: RPC, lock }) },
      waitMs: 30_000,
    });
    // Two passes at once: SKIP LOCKED gives the command to only one of them.
    await Promise.all([worker.runOnce(), worker.runOnce()]);

    const done = await getCommand(pool, id);
    expect(done?.status).toBe("confirmed");
    expect(done?.tx?.from).toBe(demoAddresses().get("ISSUANCE_SAFE")?.toLowerCase());
    const after = await client.readContract({ address: d.token, abi: tokenAbi, functionName: "balanceOf", args: [alice] });
    expect(after - before).toBe(7n);
    expect(await client.readContract({ address: d.issuance, abi: issuanceGuardAbi, functionName: "refUsed", args: [refId] })).toBe(true);
    const receipt = await client.getTransactionReceipt({ hash: done?.tx?.hash ?? "0x" });
    expect(receipt.status).toBe("success");

    // A second command with the same refId is refused by simulation: failed, nothing recorded.
    const dup = await enqueue(pool, { idempotencyKey: `mint:${refId}:again`, kind: "issuance.mint", payload, createdBy: "test" });
    await worker.runOnce();
    const refused = await getCommand(pool, dup);
    expect(refused).toMatchObject({ status: "failed", tx: null });
    expect(refused?.lastError).toMatch(/RefusedError/);
    expect(await client.readContract({ address: d.token, abi: tokenAbi, functionName: "balanceOf", args: [alice] })).toBe(after);
  });

  it("refuses a malformed payload without sending", async () => {
    const lock = pgSignerLock(settings);
    const worker = new OutboxWorker(pool, {
      workerId: "chain-test-2",
      executors: { "issuance.mint": localMintExecutor({ rpcUrl: RPC, lock }) },
    });
    const id = await enqueue(pool, {
      idempotencyKey: `mint:bad:${String(Date.now())}`,
      kind: "issuance.mint",
      payload: { issuance: "0x1234", to: "nobody", amount: "-5", refId: "0x00" },
      createdBy: "test",
    });
    await worker.runOnce();
    expect(await getCommand(pool, id)).toMatchObject({ status: "failed", tx: null });
  });
});
