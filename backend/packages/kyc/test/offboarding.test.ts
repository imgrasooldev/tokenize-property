import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { scratchDatabase } from "../../db/test/helpers.ts";
import { Peppers } from "../src/crypto.ts";
import { OffboardingWorker } from "../src/offboarding.ts";
import { MockSanctions, mockProviders } from "../src/providers.ts";
import { KycService, revoke } from "../src/service.ts";

/** Step 5h I-3: a lost verification becomes exactly one freeze command in the outbox. */
const MIGRATIONS = fileURLToPath(new URL("../../db/migrations", import.meta.url));
const FREEZE_GUARD = `0x${"f1".repeat(20)}`;
let db: pg.Client;
let pool: pg.Pool;
let drop: () => Promise<void>;
let kyc: KycService;
let seq = 0;
const peppers = Peppers.of([{ version: 1, key: randomBytes(32) }]);
const dataKey = randomBytes(32);

beforeAll(async () => {
  const s = await scratchDatabase();
  ({ client: db, drop } = s);
  await migrate(db, MIGRATIONS);
  pool = new pg.Pool({ ...s.settings, max: 4 });
  kyc = new KycService(pool, mockProviders(), peppers, dataKey);
});

afterAll(async () => {
  await pool.end();
  await drop();
});

async function verified(name = "Offboard Candidate"): Promise<{ subjectId: string; wallet: string }> {
  const wallet = `0x${randomBytes(20).toString("hex")}`;
  const r = await kyc.onboard({ cnic: `61101${String(1_000_000 + ++seq).slice(-7)}1`, fullName: name, livenessSessionId: `sess-off-${String(seq).padStart(4, "0")}`, wallet });
  expect(r.status).toBe("verified");
  return { subjectId: r.subjectId, wallet };
}

async function freezes(): Promise<{ key: string; account: string; caseId: string }[]> {
  const { rows } = await db.query<{ key: string; account: string; caseId: string }>(
    "SELECT idempotency_key AS key, payload->>'account' AS account, payload->>'caseId' AS \"caseId\" FROM outbox.commands WHERE kind = 'compliance.freeze' ORDER BY id",
  );
  return rows;
}

describe("offboarding (I-3)", () => {
  it("queues nothing for verified investors, one freeze per lost verification, never twice", async () => {
    const worker = new OffboardingWorker(pool, { freezeGuard: FREEZE_GUARD });
    const a = await verified();
    const b = await verified();
    expect(await worker.runOnce()).toBe(0);
    await revoke(db, a.subjectId, "officer:amna", "Court order received for this investor");
    expect(await worker.runOnce()).toBe(1);
    expect(await worker.runOnce()).toBe(0);
    const [first] = await freezes();
    expect(first?.account).toBe(a.wallet);
    expect(first?.key.startsWith(`compliance.freeze:${a.subjectId}:`) && first.key.endsWith(":revoked")).toBe(true);
    expect(first?.caseId).toMatch(/^0x[0-9a-f]{64}$/);

    // A re-screening hit (possible match, review) on b.
    const hit = new KycService(pool, { ...mockProviders(), sanctions: { screen: () => new MockSanctions().screen({ fullName: "Bilal Fictitious Khan" }) } }, peppers, dataKey);
    expect(await hit.rescreen(b.subjectId)).toBe("review");
    expect(await worker.runOnce()).toBe(1);
    expect((await freezes()).map((f) => f.account)).toEqual([a.wallet, b.wallet]);
  });

  it("an expired verification is offboarded too", async () => {
    const worker = new OffboardingWorker(pool, { freezeGuard: FREEZE_GUARD });
    const c = await verified();
    await db.query("ALTER TABLE kyc.decisions DISABLE TRIGGER decisions_append_only");
    await db.query("UPDATE kyc.decisions SET valid_until = now() - interval '1 minute' WHERE subject_id = $1", [c.subjectId]);
    await db.query("ALTER TABLE kyc.decisions ENABLE TRIGGER decisions_append_only");
    const before = (await freezes()).length;
    await worker.runOnce();
    const after = await freezes();
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)?.key).toMatch(/:expired$/);
  });

  it("the worker reacts to kyc_alert at once and does not double a freeze under concurrent passes", async () => {
    const worker = new OffboardingWorker(pool, { freezeGuard: FREEZE_GUARD, pollMs: 60_000 });
    await worker.start();
    try {
      const d = await verified();
      const before = (await freezes()).length;
      await revoke(db, d.subjectId, "officer:amna", "Investor offboarded by compliance");
      const t0 = Date.now();
      while ((await freezes()).length === before && Date.now() - t0 < 3_000) await new Promise((r) => setTimeout(r, 25));
      expect((await freezes()).length).toBe(before + 1);
      const counts = await Promise.all(Array.from({ length: 5 }, () => worker.runOnce()));
      expect(counts.reduce((x, y) => x + y, 0)).toBe(0);
      const { rows } = await db.query<{ n: string }>("SELECT count(*) AS n FROM kyc.audit WHERE action = 'offboarding.enqueued' AND detail->>'subject' = $1", [d.subjectId]);
      expect(rows[0]?.n).toBe("1");
    } finally {
      await worker.stop();
    }
  });

  it("refuses a bad FreezeGuard address and keeps the KYC audit chain intact", async () => {
    expect(() => new OffboardingWorker(pool, { freezeGuard: "0x123" })).toThrow();
    await expect(db.query("SELECT kyc.enqueue_offboarding('nonsense', 'x')")).rejects.toThrow(/FreezeGuard/);
    // The only problem allowed is the decision this file aged by hand (expiry test).
    const { rows } = await db.query<{ problem: string }>("SELECT problem FROM kyc.verify_audit()");
    expect(rows.every((r) => /decision \d+ changed after it was made/.test(r.problem))).toBe(true);
  });
});
