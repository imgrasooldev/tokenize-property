import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvFile } from "@pt/config";
import { tokenAbi } from "@pt/contracts";
import { enqueue, getCommand, OutboxWorker } from "@pt/outbox";
import pg from "pg";
import { createPublicClient, http, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { scratchDatabase } from "../../db/test/helpers.ts";
import { demoAddresses, latestDeployment } from "../../demo-console/src/local.ts";
import { signerExecutor } from "../src/executor.ts";
import { createSignerServer, SignerClient, type Client } from "../src/http.ts";
import { FileKeystore, writeKeyFile } from "../src/keystore.ts";
import { SignerService, viemChainReader } from "../src/service.ts";

/**
 * End to end on the real local Besu network: outbox command -> worker -> signer over HTTP (policy,
 * maker-checker, nonce, audit) -> record -> broadcast -> mint. Skipped when the network is down (CI).
 */
const MIGRATIONS = fileURLToPath(new URL("../../db/migrations", import.meta.url));
const DEV = fileURLToPath(new URL("../../../../chain/network/dev-accounts.env", import.meta.url));
const RPC = "http://127.0.0.1:8545";
const PASS = randomBytes(32).toString("base64url");

const rpc = createPublicClient({ transport: http(RPC, { timeout: 3_000 }) });
async function up(): Promise<boolean> {
  try {
    return (await rpc.getChainId()) === 586586 && latestDeployment() !== null && Boolean(readEnvFile(DEV).ISSUANCE_SAFE_KEY);
  } catch {
    return false;
  }
}
const live = await up();

describe.skipIf(!live)("outbox + signing service on the local chain", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  let server: Server;
  let worker: OutboxWorker;
  let signer: SignerClient;
  const d = latestDeployment();
  const alice = demoAddresses().get("ALICE") as Hex;

  beforeAll(async () => {
    if (!d) throw new Error("no deployment");
    let settings: pg.ClientConfig;
    ({ client: admin, settings, drop } = await scratchDatabase());
    await migrate(admin, MIGRATIONS);
    pool = new pg.Pool({ ...settings, max: 10 });

    const dir = await mkdtemp(join(tmpdir(), "ks-"));
    await writeKeyFile(dir, "issuance", readEnvFile(DEV).ISSUANCE_SAFE_KEY as Hex, PASS);
    const keys = await FileKeystore.open(dir, PASS);
    await admin.query("INSERT INTO signer.keys (key_ref, address, purpose) VALUES ('issuance', $1, 'test')", [keys.address("issuance")]);
    const rule = {
      chainId: 586586, keyRef: "issuance", issuance: d.issuance.toLowerCase(), token: d.token.toLowerCase(), identityRegistry: d.ir.toLowerCase(),
      maxPerCommand: "1000", maxPerDay: "100000", approvalAbove: "50", approvals: 2,
    };
    const { rows } = await admin.query<{ id: string }>("SELECT signer.propose_policy('issuance.mint', $1::jsonb, 'maker') AS id", [JSON.stringify(rule)]);
    await admin.query("SELECT signer.approve_policy($1, 'checker')", [rows[0]?.id]);

    const client: Client = { id: "outbox-worker", secret: randomBytes(32) };
    server = createSignerServer(new SignerService(pool, keys, viemChainReader(RPC)), [client]);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    signer = new SignerClient(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, client);
    worker = new OutboxWorker(pool, { workerId: "e2e-worker", executors: { "issuance.mint": signerExecutor(signer, { rpcUrl: RPC, approvalPollSeconds: 1 }) }, waitMs: 30_000 });
  });

  afterAll(async () => {
    server.close();
    await pool.end();
    await drop();
  });

  const balance = () => rpc.readContract({ address: d?.token as Hex, abi: tokenAbi, functionName: "balanceOf", args: [alice] });
  const mint = (amount: string, to: Hex = alice) => ({ issuance: d?.issuance ?? "", to, amount, refId: `0x${randomBytes(32).toString("hex")}` });

  it("mints a small amount straight through: policy, nonce, record, broadcast, confirm", async () => {
    const before = await balance();
    const id = await enqueue(pool, { idempotencyKey: `e2e:${randomBytes(6).toString("hex")}`, kind: "issuance.mint", payload: mint("7"), createdBy: "test" });
    await worker.runOnce();
    const cmd = await getCommand(pool, id);
    expect(cmd?.status).toBe("confirmed");
    expect(await balance()).toBe(before + 7n);
    const req = await admin.query<{ status: string; tx_hash: string }>("SELECT status, tx_hash FROM signer.requests ORDER BY created_at DESC LIMIT 1");
    expect(req.rows[0]).toMatchObject({ status: "broadcast", tx_hash: cmd?.tx?.hash });
  });

  it("holds a large mint for two approvals without using attempts, then mints it", async () => {
    const before = await balance();
    const id = await enqueue(pool, { idempotencyKey: `e2e:${randomBytes(6).toString("hex")}`, kind: "issuance.mint", payload: mint("60"), createdBy: "test" });
    await worker.runOnce();
    let cmd = await getCommand(pool, id);
    expect(cmd).toMatchObject({ status: "pending", attempts: 0, tx: null });
    expect(cmd?.lastError).toMatch(/awaiting 2 approvals/);
    const { rows } = await admin.query<{ id: string }>("SELECT id FROM signer.requests WHERE status = 'pending_approval'");
    await admin.query("SELECT signer.decide($1, 'ops-ana', 'approve', 'KYC and payment checked')", [rows[0]?.id]);
    await admin.query("SELECT signer.decide($1, 'trustee-bilal', 'approve', 'trustee co-sign')", [rows[0]?.id]);
    await admin.query("UPDATE outbox.commands SET available_at = now() WHERE id = $1", [id.toString()]);
    await worker.runOnce();
    cmd = await getCommand(pool, id);
    expect(cmd?.status).toBe("confirmed");
    expect(await balance()).toBe(before + 60n);
  });

  it("denies an unverified recipient: command failed, nothing signed or sent", async () => {
    const nonces = (await admin.query<{ n: string }>("SELECT count(*) AS n FROM signer.nonces")).rows[0]?.n;
    const stranger: Hex = `0x${randomBytes(20).toString("hex")}`;
    const id = await enqueue(pool, { idempotencyKey: `e2e:${randomBytes(6).toString("hex")}`, kind: "issuance.mint", payload: mint("5", stranger), createdBy: "test" });
    await worker.runOnce();
    const cmd = await getCommand(pool, id);
    expect(cmd).toMatchObject({ status: "failed", tx: null });
    expect(cmd?.lastError).toMatch(/not verified/);
    expect((await admin.query<{ n: string }>("SELECT count(*) AS n FROM signer.nonces")).rows[0]?.n).toBe(nonces);
  });

  it("signs a policy-checked transaction over HTTP quickly, chain reads included", async () => {
    const times: number[] = [];
    const warm = await signer.sign({ commandRef: `warm:${randomBytes(6).toString("hex")}`, kind: "issuance.mint", payload: mint("1") });
    if (warm.status === "signed") await signer.release(warm.requestId);
    for (let i = 0; i < 25; i++) {
      const t = performance.now();
      const r = await signer.sign({ commandRef: `lat:${randomBytes(6).toString("hex")}`, kind: "issuance.mint", payload: mint("1") });
      times.push(performance.now() - t);
      if (r.status === "signed") await signer.release(r.requestId);
    }
    times.sort((a, b) => a - b);
    const p50 = times[12] ?? 0;
    const p99 = times[24] ?? 0;
    process.stdout.write(`signer latency over HTTP incl. Besu reads: p50 ${p50.toFixed(1)} ms, p99 ${p99.toFixed(1)} ms\n`);
    // Dominated by Besu: the identity-registry check alone takes 20-95 ms on this machine.
    expect(p50).toBeLessThan(200);
  });

  it("leaves an intact audit chain", async () => {
    expect((await admin.query("SELECT * FROM signer.verify_audit()")).rows).toHaveLength(0);
  });
});
