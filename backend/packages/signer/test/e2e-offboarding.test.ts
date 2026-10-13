import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvFile } from "@pt/config";
import { tokenAbi } from "@pt/contracts";
import { KycService, mockProviders, OffboardingWorker, Peppers, revoke } from "@pt/kyc";
import { getCommand, OutboxWorker } from "@pt/outbox";
import pg from "pg";
import { createPublicClient, http, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { scratchDatabase } from "../../db/test/helpers.ts";
import { latestDeployment } from "../../demo-console/src/local.ts";
import { signerExecutor } from "../src/executor.ts";
import { createSignerServer, SignerClient, type Client } from "../src/http.ts";
import { FileKeystore, writeKeyFile } from "../src/keystore.ts";
import { SignerService, viemChainReader } from "../src/service.ts";

/**
 * Step 5h end to end on the real local Besu network: an investor loses their verification ->
 * offboarding worker -> outbox compliance.freeze -> signing service (policy: owner not verified,
 * daily limit; Ops Safe key) -> record -> broadcast -> FreezeGuard.freezeAddress -> the token
 * reports the wallet frozen. A random wallet is used, so the demo's investors are not touched.
 * Skipped when the network is down (CI).
 */
const MIGRATIONS = fileURLToPath(new URL("../../db/migrations", import.meta.url));
const DEV = fileURLToPath(new URL("../../../../chain/network/dev-accounts.env", import.meta.url));
const RPC = "http://127.0.0.1:8545";
const PASS = randomBytes(32).toString("base64url");
const rpc = createPublicClient({ transport: http(RPC, { timeout: 3_000 }) });

async function up(): Promise<boolean> {
  try {
    return (await rpc.getChainId()) === 586586 && latestDeployment() !== null && Boolean(readEnvFile(DEV).OPS_SAFE_KEY);
  } catch {
    return false;
  }
}
const live = await up();

describe.skipIf(!live)("offboarding freeze on the local chain", () => {
  const d = latestDeployment();
  let admin: pg.Client;
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  let server: Server;
  let worker: OutboxWorker;

  beforeAll(async () => {
    if (!d) throw new Error("no deployment");
    let settings: pg.ClientConfig;
    ({ client: admin, settings, drop } = await scratchDatabase());
    await migrate(admin, MIGRATIONS);
    pool = new pg.Pool({ ...settings, max: 10 });
    const dir = await mkdtemp(join(tmpdir(), "ks-"));
    await writeKeyFile(dir, "ops", readEnvFile(DEV).OPS_SAFE_KEY as Hex, PASS);
    const keys = await FileKeystore.open(dir, PASS);
    await admin.query("INSERT INTO signer.keys (key_ref, address, purpose) VALUES ('ops', $1, 'Ops Safe (local dev key)')", [keys.address("ops")]);
    const rule = { chainId: 586586, keyRef: "ops", freezeGuard: d.freezeGuard.toLowerCase(), token: d.token.toLowerCase(), maxPerDay: 20, approvals: 0 };
    const { rows } = await admin.query<{ id: string }>("SELECT signer.propose_policy('compliance.freeze', $1::jsonb, 'maker') AS id", [JSON.stringify(rule)]);
    await admin.query("SELECT signer.approve_policy($1, 'checker')", [rows[0]?.id]);
    const client: Client = { id: "outbox-worker", secret: randomBytes(32) };
    server = createSignerServer(new SignerService(pool, keys, viemChainReader(RPC)), [client]);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const signer = new SignerClient(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, client);
    worker = new OutboxWorker(pool, { workerId: "e2e-offboarding", executors: { "compliance.freeze": signerExecutor(signer, { rpcUrl: RPC }) }, waitMs: 30_000 });
  });

  afterAll(async () => {
    server.close();
    await pool.end();
    await drop();
  });

  it("a revoked investor's wallet is frozen on chain, once", async () => {
    if (!d) throw new Error("no deployment");
    const wallet = `0x${randomBytes(20).toString("hex")}`;
    const kyc = new KycService(pool, mockProviders(), Peppers.of([{ version: 1, key: randomBytes(32) }]), randomBytes(32));
    const r = await kyc.onboard({ cnic: "6110100000011", fullName: "Chain Offboard", livenessSessionId: "sess-e2e-off-01", wallet });
    expect(r.status).toBe("verified");
    const frozen = () => rpc.readContract({ address: d.token, abi: tokenAbi, functionName: "isFrozen", args: [wallet] });
    expect(await frozen()).toBe(false);

    await revoke(admin, r.subjectId, "officer:amna", "Sanctions match confirmed by two officers");
    expect(await new OffboardingWorker(pool, { freezeGuard: d.freezeGuard }).runOnce()).toBe(1);
    await worker.runOnce();
    const { rows } = await admin.query<{ id: string }>("SELECT id FROM outbox.commands WHERE kind = 'compliance.freeze'");
    const cmd = await getCommand(pool, BigInt(rows[0]?.id ?? "0"));
    expect(cmd?.status).toBe("confirmed");
    expect(await frozen()).toBe(true);

    // Nothing more to do: no second command, and the policy would refuse an already frozen wallet.
    expect(await new OffboardingWorker(pool, { freezeGuard: d.freezeGuard }).runOnce()).toBe(0);
    const audit = await admin.query("SELECT * FROM signer.verify_audit()");
    expect(audit.rows).toEqual([]);
  });
});
