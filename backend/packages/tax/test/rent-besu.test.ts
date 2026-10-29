import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvFile } from "@pt/config";
import { distributionRegistryAbi } from "@pt/contracts";
import { getCommand, OutboxWorker } from "@pt/outbox";
import pg from "pg";
import { createPublicClient, http, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { adminSettings, contiguousMigrations } from "../../db/test/helpers.ts";
import { deploymentFromBroadcast, Indexer, LOCAL_BROADCAST, rpcSource } from "../../indexer/src/index.ts";
import { signerExecutor } from "../../signer/src/executor.ts";
import { createSignerServer, SignerClient, type Client } from "../../signer/src/http.ts";
import { FileKeystore, writeKeyFile } from "../../signer/src/keystore.ts";
import { SignerService, viemChainReader } from "../../signer/src/service.ts";
import { OpsService } from "../src/service.ts";
import { allowPlaceholders, calculate, collect, message, trusteePrecheck, type TestToken, type World } from "./world.ts";

/**
 * T-022 end to end on the real local Besu network: an approved S-03 calculation over the real
 * token's holders (indexed from the chain) -> ops.request_publish -> outbox -> signing service ->
 * DistributionRegistry.publish on Besu -> indexer -> the 48-hour window refuses finalisation in the
 * database AND on chain -> (a later run, 48 hours on) ops.request_finalize -> signer -> finalize ->
 * indexer -> ops.book_distribution (rent:wht and rent:distribution journals).
 *
 * The challenge window is a contract constant and Besu blocks carry wall-clock time, so the two
 * halves run 48 hours apart. They share the persistent database `pt_rent_e2e` in the local cluster
 * (never a production database; it only ever follows chain 586586). A run first finalises and
 * books every publication whose window has closed, then publishes a new calculation unless one is
 * still in its window. Skipped when the network or the dev keys are not available (CI).
 */
const DB = "pt_rent_e2e";
const RPC = "http://127.0.0.1:8545";
const DEV = fileURLToPath(new URL("../../../../chain/network/dev-accounts.env", import.meta.url));
const PASS = randomBytes(32).toString("base64url");
const deployment = deploymentFromBroadcast(process.env.INDEXER_DEPLOYMENT_FILE ?? LOCAL_BROADCAST);
const rpc = createPublicClient({ transport: http(RPC, { timeout: 5_000 }) });

async function up(): Promise<boolean> {
  try {
    return deployment !== null && (await rpc.getChainId()) === 586586 && Boolean(readEnvFile(DEV).OPS_SAFE_KEY);
  } catch {
    return false;
  }
}
const live = await up();

/** Opens (creating and migrating on first use) the persistent end-to-end database. */
async function persistentWorld(): Promise<World> {
  const root = new pg.Client(adminSettings());
  await root.connect();
  try {
    const { rowCount } = await root.query("SELECT 1 FROM pg_database WHERE datname = $1", [DB]);
    if (!rowCount) await root.query(`CREATE DATABASE ${DB}`);
  } finally {
    await root.end();
  }
  const settings = adminSettings(DB);
  const su = new pg.Client(settings);
  await su.connect();
  await migrate(su, contiguousMigrations());
  const pool = new pg.Pool({ ...settings, max: 8 });
  const ops = new pg.Pool({ ...settings, max: 3, options: "-c role=pt_ops_operator" });
  return {
    su,
    settings,
    pool,
    ops,
    taxdb: ops,
    peppers: undefined as never,
    kyc: undefined as never,
    drop: async () => {
      await ops.end();
      await pool.end();
      await su.end();
    },
  };
}

/** A month far in the past that this token has no calculation for yet (one calculation per period). */
async function freePeriod(w: World, token: string): Promise<string> {
  const { rows } = await w.su.query<{ n: string }>("SELECT count(*)::text AS n FROM ops.distributions WHERE token = $1", [token]);
  const n = Number(rows[0]?.n ?? "0");
  return `${String(2000 + Math.floor(n / 12))}-${String((n % 12) + 1).padStart(2, "0")}`;
}

describe.skipIf(!live)("rent publish -> 48 h -> finalize -> book on the local Besu network (T-022)", () => {
  let w: World;
  let t: TestToken;
  let ix: Indexer;
  let server: Server;
  let worker: OutboxWorker;

  beforeAll(async () => {
    const d = deployment;
    if (!d) throw new Error("no deployment");
    w = await persistentWorld();
    ix = new Indexer(w.pool, rpcSource(RPC, { timeoutMs: 5_000 }), d);
    await ix.register();
    await ix.catchUp();
    const token = d.contracts.token.toLowerCase();
    const registry = (d.contracts.distributions ?? "").toLowerCase();
    if (!registry) throw new Error("the deployment has no DistributionRegistry");
    t = { token, deployment: d.id, registry };

    const dir = await mkdtemp(join(tmpdir(), "ks-"));
    await writeKeyFile(dir, "ops", readEnvFile(DEV).OPS_SAFE_KEY as Hex, PASS);
    const keys = await FileKeystore.open(dir, PASS);
    await w.su.query("INSERT INTO signer.keys (key_ref, address, purpose) VALUES ('ops', $1, 'rent e2e') ON CONFLICT DO NOTHING", [keys.address("ops")]);
    for (const kind of ["rent.publish", "rent.finalize"]) {
      const live = await w.su.query("SELECT 1 FROM signer.policies WHERE kind = $1 AND approved_at IS NOT NULL AND retired_at IS NULL", [kind]);
      if (live.rowCount) continue;
      const rule = { chainId: 586586, keyRef: "ops", registry, token, approvals: 0 };
      const { rows } = await w.su.query<{ id: string }>("SELECT signer.propose_policy($1, $2::jsonb, 'maker') AS id", [kind, JSON.stringify(rule)]);
      await w.su.query("SELECT signer.approve_policy($1, 'checker')", [rows[0]?.id]);
    }
    // The reconciliation payout gate applies to rent.* (ADR 0007): a run that passed just now.
    const run = await w.su.query<{ id: string }>("SELECT recon.start_run('rent-e2e', NULL, '{}') AS id");
    await w.su.query("SELECT recon.complete_run($1, 'rent-e2e', 0, '[]', '{}')", [run.rows[0]?.id]);
    await allowPlaceholders(w, true);

    const client: Client = { id: "outbox-worker", secret: randomBytes(32) };
    server = createSignerServer(new SignerService(w.pool, keys, viemChainReader(RPC)), [client]);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const signer = new SignerClient(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, client);
    const exec = signerExecutor(signer, { rpcUrl: RPC, approvalPollSeconds: 1 });
    worker = new OutboxWorker(w.pool, { workerId: "rent-e2e", executors: { "rent.publish": exec, "rent.finalize": exec }, waitMs: 30_000 });
  }, 600_000);

  afterAll(async () => {
    server.close();
    await w.drop();
  });

  /** Runs the worker until the command leaves pending/claimed; returns its final status. */
  async function settle(id: bigint): Promise<string> {
    for (let i = 0; i < 5; i++) {
      await worker.runOnce();
      const c = await getCommand(w.pool, id);
      if (c && c.status !== "pending" && c.status !== "claimed") return c.status;
    }
    return (await getCommand(w.pool, id))?.status ?? "missing";
  }

  const onChain = (id: bigint) => rpc.readContract({ address: t.registry as Hex, abi: distributionRegistryAbi, functionName: "getDistribution", args: [id] });

  it("finalises and books every publication whose 48-hour window has closed", async (ctx) => {
    const { rows: due } = await w.su.query<{ calc: string; id: string; closes: Date | null }>(
      `SELECT d.id::text AS calc, c.id::text AS id, trustee.window_closes(c.registry, c.id) AS closes
       FROM ops.distributions d JOIN chain.distributions c ON c.token = d.token AND c.statement_hash = d.statement_hash AND c.registry = $1
       WHERE d.status = 'approved' AND c.status IN ('published', 'finalized') ORDER BY c.id`,
      [t.registry],
    );
    const ready = due.filter((r) => r.closes !== null && r.closes.getTime() <= Date.now());
    if (ready.length === 0) {
      const next = due.map((r) => r.closes?.toISOString()).filter(Boolean).join(", ");
      ctx.skip(next ? `no window has closed yet (closes ${next}); run again then` : "nothing published yet; this run publishes one");
      return;
    }
    for (const r of ready) {
      const status = (await w.su.query<{ s: string }>("SELECT status AS s FROM chain.distributions WHERE registry = $1 AND id = $2", [t.registry, r.id])).rows[0]?.s;
      if (status === "published") {
        const cmd = (await w.ops.query<{ r: string }>("SELECT ops.request_finalize($1, $2, 'operator:omar')::text AS r", [t.registry, r.id])).rows[0]?.r ?? "";
        expect(await settle(BigInt(cmd))).toBe("confirmed");
        await ix.catchUp();
      }
      expect((await onChain(BigInt(r.id))).status).toBe(2); // Finalized
      expect((await w.su.query<{ s: string }>("SELECT status AS s FROM chain.distributions WHERE registry = $1 AND id = $2", [t.registry, r.id])).rows[0]?.s).toBe("finalized");
      await w.ops.query("SELECT ops.book_distribution($1, $2, $3, 'operator:omar')", [r.calc, t.registry, r.id]);
      const booked = await w.su.query<{ status: string; j: string | null }>("SELECT status, distribution_journal_id::text AS j FROM ops.distributions WHERE id = $1", [r.calc]);
      expect(booked.rows[0]?.status).toBe("booked");
      expect(booked.rows[0]?.j).not.toBeNull();
      const j = await w.su.query("SELECT 1 FROM ledger.journals WHERE id = $1", [booked.rows[0]?.j]);
      expect(j.rowCount).toBe(1);
    }
  }, 300_000);

  it("publishes an approved calculation through outbox + signer; the window holds in the database and on chain", async () => {
    const open = await w.su.query<{ calc: string; id: string }>(
      `SELECT d.id::text AS calc, c.id::text AS id FROM ops.distributions d
       JOIN chain.distributions c ON c.token = d.token AND c.statement_hash = d.statement_hash AND c.registry = $1
       WHERE d.status = 'approved' AND c.status = 'published' AND trustee.window_closes(c.registry, c.id) > now() ORDER BY c.id DESC LIMIT 1`,
      [t.registry],
    );
    let id = open.rows[0]?.id ?? "";
    if (!id) {
      const period = await freePeriod(w, t.token);
      await collect(w, t, `${period}-15`, 10_000_000n);
      const today = (await w.su.query<{ d: string }>("SELECT ops.pkt_today()::text AS d")).rows[0]?.d ?? "";
      const head = (await ix.cursor()).blockNumber;
      const calcId = await calculate(w, t, period, today, Number(head) - 1);
      const docs = await new OpsService(w.ops).attach(calcId, "operator:omar");
      expect(await trusteePrecheck(w, calcId)).toMatchObject({ ok: true });
      await w.ops.query("SELECT ops.decide_distribution($1, 'operator:sara', 'approve', 'recomputed from chain and statement')", [calcId]);

      const cmd = (await w.ops.query<{ r: string }>("SELECT ops.request_publish($1, 'operator:omar')::text AS r", [calcId])).rows[0]?.r ?? "";
      expect(await settle(BigInt(cmd))).toBe("confirmed");
      await ix.catchUp();
      const c = await w.su.query<{ id: string; status: string; total: string }>(
        "SELECT id::text, status, total_paisa::text AS total FROM chain.distributions WHERE registry = $1 AND statement_hash = $2",
        [t.registry, docs.statementHash],
      );
      expect(c.rows[0]?.status).toBe("published");
      id = c.rows[0]?.id ?? "";
      const net = (await w.su.query<{ n: string }>("SELECT sum_net::text AS n FROM ops.distributions WHERE id = $1", [calcId])).rows[0]?.n;
      const d = await onChain(BigInt(id));
      expect(d.token.toLowerCase()).toBe(t.token);
      expect(d).toMatchObject({ status: 1, merkleRoot: docs.root, statementHash: docs.statementHash });
      expect(d.totalPaisa.toString()).toBe(net);
      expect(c.rows[0]?.total).toBe(net);
      // The same calculation cannot be published twice.
      expect(await message(w.ops.query("SELECT ops.request_publish($1, 'operator:omar')", [calcId]))).toMatch(/already published/);
    }
    // Inside the 48-hour window: refused by the database, and the contract would revert anyway.
    expect(await message(w.ops.query("SELECT ops.request_finalize($1, $2, 'operator:omar')", [t.registry, id]))).toMatch(/challenge window closes/);
    const ops = readEnvFile(DEV).OPS_SAFE as Hex;
    await expect(rpc.simulateContract({ address: t.registry as Hex, abi: distributionRegistryAbi, functionName: "finalize", args: [BigInt(id)], account: ops })).rejects.toThrow(/WindowOpen/);
  }, 300_000);
});
