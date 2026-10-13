import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { recoverTransactionAddress } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { scratchDatabase } from "../../db/test/helpers.ts";
import { FileKeystore, writeKeyFile } from "../src/keystore.ts";
import { SignerService, type ChainReader } from "../src/service.ts";

/** Service flows on a scratch database with a scripted chain (no Besu needed; runs in CI). */
const MIGRATIONS = fileURLToPath(new URL("../../db/migrations", import.meta.url));
const PASS = "a-long-local-test-passphrase-0123456789";
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

let admin: pg.Client;
let pool: pg.Pool;
let drop: () => Promise<void>;
let keys: FileKeystore;
let n = 0;

const chainState = { verified: true, supply: 0n, cap: 1_000_000n, paused: false, simulateFails: false, pending: 0n, dropped: new Set<string>() };
const chain: ChainReader = {
  chainId: () => Promise.resolve(586586),
  pendingNonce: () => Promise.resolve(chainState.pending),
  simulate: () => (chainState.simulateFails ? Promise.reject(new Error("execution reverted: RefAlreadyUsed")) : Promise.resolve()),
  mintFacts: () => Promise.resolve({ recipientVerified: chainState.verified, supply: chainState.supply, cap: chainState.cap, paused: chainState.paused }),
  txState: (hash) => Promise.resolve(chainState.dropped.has(hash) ? "dropped" : "pending"),
  isFrozen: () => Promise.resolve(false),
  distribution: () => Promise.resolve({ status: "none", token: A(2) }),
};

const ref = () => `cmd:${String(++n)}:${String(Date.now())}`;
const mint = (amount: string) => ({ issuance: A(1), to: A(9), amount, refId: `0x${(n + 1).toString(16).padStart(64, "0")}` });

beforeAll(async () => {
  let settings: pg.ClientConfig;
  ({ client: admin, settings, drop } = await scratchDatabase());
  await migrate(admin, MIGRATIONS);
  pool = new pg.Pool({ ...settings, max: 20 });
  const dir = await mkdtemp(join(tmpdir(), "ks-"));
  await writeKeyFile(dir, "issuance", generatePrivateKey(), PASS);
  keys = await FileKeystore.open(dir, PASS);
  await admin.query("INSERT INTO signer.keys (key_ref, address, purpose) VALUES ('issuance', $1, 'test')", [keys.address("issuance")]);
  const rule = { chainId: 586586, keyRef: "issuance", issuance: A(1), token: A(2), identityRegistry: A(3), maxPerCommand: "100000", maxPerDay: "300000", approvalAbove: "10000", approvals: 2 };
  const { rows } = await admin.query<{ id: string }>("SELECT signer.propose_policy('issuance.mint', $1::jsonb, 'maker') AS id", [JSON.stringify(rule)]);
  await admin.query("SELECT signer.approve_policy($1, 'checker')", [rows[0]?.id]);
});

afterAll(async () => {
  await pool.end();
  await drop();
});

const svc = () => new SignerService(pool, keys, chain);

describe("signing requests", () => {
  it("signs a small mint with the policy's key and a reserved nonce, idempotently", async () => {
    const r = ref();
    const p = mint("500");
    const first = await svc().request({ commandRef: r, kind: "issuance.mint", payload: p }, "outbox-worker");
    expect(first.status).toBe("signed");
    if (first.status !== "signed") return;
    expect((await recoverTransactionAddress({ serializedTransaction: first.raw as never })).toLowerCase()).toBe(keys.address("issuance"));
    const again = await svc().request({ commandRef: r, kind: "issuance.mint", payload: p }, "outbox-worker");
    expect(again).toMatchObject({ status: "signed", nonce: first.nonce, hash: first.hash });
    expect(await svc().markBroadcast(first.requestId, "outbox-worker")).toBe(true);
    expect(await svc().release(first.requestId, "outbox-worker")).toBe(false); // a broadcast nonce is never released
  });

  it("refuses a reused commandRef with a different payload", async () => {
    const r = ref();
    await svc().request({ commandRef: r, kind: "issuance.mint", payload: mint("10") }, "outbox-worker");
    expect(await svc().request({ commandRef: r, kind: "issuance.mint", payload: mint("11") }, "outbox-worker")).toMatchObject({ status: "denied", reason: /different payload/ });
  });

  it("waits for two distinct operators above the threshold, then signs", async () => {
    const r = ref();
    const p = mint("20000");
    const first = await svc().request({ commandRef: r, kind: "issuance.mint", payload: p }, "outbox-worker");
    expect(first).toMatchObject({ status: "pending_approval", approvalsNeeded: 2 });
    if (first.status !== "pending_approval") return;
    await expect(admin.query("SELECT signer.decide($1, 'outbox-worker', 'approve', 'self')", [first.requestId])).rejects.toThrow(/maker-checker/);
    expect((await admin.query<{ s: string }>("SELECT signer.decide($1, 'ops-ana', 'approve', 'checked lease') AS s", [first.requestId])).rows[0]?.s).toBe("pending_approval");
    await expect(admin.query("SELECT signer.decide($1, 'ops-ana', 'approve', 'again')", [first.requestId])).rejects.toThrow(/duplicate key/);
    expect(await svc().request({ commandRef: r, kind: "issuance.mint", payload: p }, "outbox-worker")).toMatchObject({ status: "pending_approval" });
    expect((await admin.query<{ s: string }>("SELECT signer.decide($1, 'ops-bilal', 'approve', 'trustee ok') AS s", [first.requestId])).rows[0]?.s).toBe("approved");
    expect(await svc().request({ commandRef: r, kind: "issuance.mint", payload: p }, "outbox-worker")).toMatchObject({ status: "signed" });
  });

  it("a rejection by one operator is final", async () => {
    const r = ref();
    const first = await svc().request({ commandRef: r, kind: "issuance.mint", payload: mint("15000") }, "outbox-worker");
    if (first.status !== "pending_approval") throw new Error("expected pending");
    await admin.query("SELECT signer.decide($1, 'ops-ana', 'reject', 'wrong investor')", [first.requestId]);
    expect(await svc().request({ commandRef: r, kind: "issuance.mint", payload: mint("15000") }, "outbox-worker")).toMatchObject({ status: "denied" });
  });

  it("denies unverified recipients, paused tokens and reverting simulations without reserving a nonce", async () => {
    const before = (await admin.query<{ n: string }>("SELECT count(*) AS n FROM signer.nonces")).rows[0]?.n;
    chainState.verified = false;
    expect(await svc().request({ commandRef: ref(), kind: "issuance.mint", payload: mint("10") }, "w")).toMatchObject({ status: "denied", reason: /not verified/ });
    chainState.verified = true;
    chainState.simulateFails = true;
    expect(await svc().request({ commandRef: ref(), kind: "issuance.mint", payload: mint("10") }, "w")).toMatchObject({ status: "denied", reason: /simulation reverted/ });
    chainState.simulateFails = false;
    expect((await admin.query<{ n: string }>("SELECT count(*) AS n FROM signer.nonces")).rows[0]?.n).toBe(before);
  });

  it("enforces the daily limit across requests", async () => {
    const used = await admin.query<{ n: string }>("SELECT coalesce(sum(amount),0) AS n FROM signer.requests WHERE status IN ('approved','signed','broadcast')");
    const room = 300_000n - BigInt(used.rows[0]?.n ?? "0");
    // Fill the day in 100,000-sized steps (each needs approval; approve directly in the database).
    let left = room;
    while (left > 0n) {
      const amt = left > 100_000n ? 100_000n : left;
      const r = await svc().request({ commandRef: ref(), kind: "issuance.mint", payload: mint(amt.toString()) }, "w");
      if (r.status === "pending_approval") {
        await admin.query("SELECT signer.decide($1, 'ops-ana', 'approve', 'fill')", [r.requestId]);
        await admin.query("SELECT signer.decide($1, 'ops-bilal', 'approve', 'fill')", [r.requestId]);
      }
      left -= amt;
    }
    expect(await svc().request({ commandRef: ref(), kind: "issuance.mint", payload: mint("1") }, "w")).toMatchObject({ status: "denied", reason: /daily limit/ });
  });
});

describe("nonces (S-4)", () => {
  it("hands out unique, gap-free nonces to concurrent requests, and reuses a released one", async () => {
    await admin.query("DELETE FROM signer.nonces");
    chainState.pending = 100n;
    await admin.query("UPDATE signer.policies SET retired_at = now() WHERE kind = 'issuance.mint' AND retired_at IS NULL");
    const rule = { chainId: 586586, keyRef: "issuance", issuance: A(1), token: A(2), identityRegistry: A(3), maxPerCommand: "100000", maxPerDay: "100000000", approvalAbove: "100000", approvals: 2 };
    const { rows } = await admin.query<{ id: string }>("SELECT signer.propose_policy('issuance.mint', $1::jsonb, 'maker') AS id", [JSON.stringify(rule)]);
    await admin.query("SELECT signer.approve_policy($1, 'checker')", [rows[0]?.id]);

    const results = await Promise.all(Array.from({ length: 30 }, () => svc().request({ commandRef: ref(), kind: "issuance.mint", payload: mint("1") }, "w")));
    const nonces = results.map((r) => (r.status === "signed" ? r.nonce : -1n)).sort((a, b) => (a < b ? -1 : 1));
    expect(nonces).toEqual(Array.from({ length: 30 }, (_, i) => 100n + BigInt(i)));

    const victim = results.find((r) => r.status === "signed" && r.nonce === 107n);
    if (victim?.status !== "signed") throw new Error("no nonce 107");
    expect(await svc().release(victim.requestId, "w")).toBe(true);
    const next = await svc().request({ commandRef: ref(), kind: "issuance.mint", payload: mint("1") }, "w");
    expect(next).toMatchObject({ status: "signed", nonce: 107n });
  });

  it("re-signs a request whose broadcast transaction was proven dropped", async () => {
    const r = ref();
    const p = mint("2");
    const first = await svc().request({ commandRef: r, kind: "issuance.mint", payload: p }, "w");
    if (first.status !== "signed") throw new Error("expected signed");
    await svc().markBroadcast(first.requestId, "w");
    expect(await svc().request({ commandRef: r, kind: "issuance.mint", payload: p }, "w")).toMatchObject({ status: "broadcast" });
    chainState.dropped.add(first.hash);
    chainState.pending = first.nonce + 5n;
    const again = await svc().request({ commandRef: r, kind: "issuance.mint", payload: p }, "w");
    expect(again).toMatchObject({ status: "signed" });
    if (again.status === "signed") expect(again.nonce).toBeGreaterThanOrEqual(first.nonce + 5n);
  });
});

describe("speed", () => {
  it("the signer's own work (policy, database, nonce, signature, audit) has p99 under 50 ms", async () => {
    // Warm-up runs are not counted, and there are enough samples that p99 is not simply the single
    // slowest run: with 40 samples one garbage-collection pause on a shared CI runner failed CI.
    const WARMUP = 10;
    const SAMPLES = 200;
    const times: number[] = [];
    for (let i = 0; i < WARMUP + SAMPLES; i++) {
      const t = performance.now();
      const r = await svc().request({ commandRef: ref(), kind: "issuance.mint", payload: mint("1") }, "bench");
      if (i >= WARMUP) times.push(performance.now() - t);
      if (r.status === "signed") await svc().release(r.requestId, "bench");
    }
    times.sort((a, b) => a - b);
    const p50 = times[Math.ceil(SAMPLES * 0.5) - 1] ?? 0;
    const p99 = times[Math.ceil(SAMPLES * 0.99) - 1] ?? 0;
    process.stdout.write(`signer own work: p50 ${p50.toFixed(1)} ms, p99 ${p99.toFixed(1)} ms\n`);
    expect(p99).toBeLessThan(50);
  });
});

describe("audit (S-5) and immutability", () => {
  it("records every step in an intact hash chain and detects tampering", async () => {
    const { rows } = await admin.query("SELECT * FROM signer.verify_audit()");
    expect(rows).toHaveLength(0);
    const actions = await admin.query<{ action: string }>("SELECT DISTINCT action FROM signer.audit");
    const set = new Set(actions.rows.map((r) => r.action));
    for (const a of ["policy.proposed", "policy.approved", "request.approved", "request.signed", "request.broadcast", "request.pending_approval", "request.approve", "request.reject"]) {
      expect(set.has(a), a).toBe(true);
    }
    await expect(admin.query("UPDATE signer.audit SET actor = 'x' WHERE id = 1")).rejects.toThrow(/append-only/);
    await admin.query("ALTER TABLE signer.audit DISABLE TRIGGER audit_append_only");
    await admin.query("UPDATE signer.audit SET detail = '{\"forged\":true}' WHERE id = 3");
    await admin.query("ALTER TABLE signer.audit ENABLE TRIGGER audit_append_only");
    const problems = await admin.query<{ audit_id: string }>("SELECT * FROM signer.verify_audit()");
    expect(problems.rows.map((r) => r.audit_id)).toContain("3");
  });

  it("keeps policies maker-checker and requests immutable", async () => {
    const { rows } = await admin.query<{ id: string }>("SELECT signer.propose_policy('issuance.mint', '{\"x\":1}'::jsonb, 'maker') AS id");
    await expect(admin.query("SELECT signer.approve_policy($1, 'maker')", [rows[0]?.id])).rejects.toThrow(/maker-checker/);
    await expect(admin.query("UPDATE signer.requests SET payload = '{}'::jsonb")).rejects.toThrow(/immutable/);
    await expect(admin.query("DELETE FROM signer.requests")).rejects.toThrow(/never deleted/);
    await expect(admin.query("UPDATE signer.policies SET rule = '{}'::jsonb")).rejects.toThrow(/approved once/);
  });
});
