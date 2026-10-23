import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { scratchDatabase, serviceLogin } from "../../db/test/helpers.ts";
import { Peppers } from "../src/crypto.ts";
import { MockSanctions, mockProviders, type ProviderResult } from "../src/providers.ts";
import {
  decideClearance,
  isVerified,
  KycError,
  KycService,
  recordCheck,
  requestClearance,
  revoke,
  statusOf,
  subjectStatus,
  verifyAudit,
} from "../src/service.ts";

/** Step 5g KYC (migration 0009, ADR 0009): Y-1..Y-6 against a real PostgreSQL. */

const MIGRATIONS = fileURLToPath(new URL("../../db/migrations", import.meta.url));
let db: pg.Client;
/** The KYC service runs as a login in pt_svc_kyc (T-012, migration 0029), as in production. */
let pool: pg.Pool;
let login: Awaited<ReturnType<typeof serviceLogin>>;
let drop: () => Promise<void>;
const peppers = Peppers.of([{ version: 1, key: randomBytes(32) }]);
const dataKey = randomBytes(32);
const providers = mockProviders();
let kyc: KycService;
let seq = 1000;

/** A fresh CNIC whose last digit selects the mock NADRA behaviour. */
const cnic = (last = 1): string => `35202-${String(1_000_000 + ++seq).slice(-7)}-${String(last)}`;
const wallet = (): string => `0x${randomBytes(20).toString("hex")}`;

beforeAll(async () => {
  const s = await scratchDatabase();
  ({ client: db, drop } = s);
  await migrate(db, MIGRATIONS);
  login = await serviceLogin("kyc", String(s.settings.database));
  pool = new pg.Pool({ ...login.settings, max: 4 });
  kyc = new KycService(pool, providers, peppers, dataKey);
});

afterAll(async () => {
  await pool.end();
  await drop();
  await login.drop();
});

describe("onboarding", () => {
  it("verifies a person who passes all three checks and binds their wallet", async () => {
    const w = wallet();
    const r = await kyc.onboard({ cnic: cnic(), fullName: "Ayesha Siddiqui", livenessSessionId: "sess-good-0001", wallet: w });
    expect(r.status).toBe("verified");
    expect(r.checks.map((c) => `${c.kind}:${c.outcome}`)).toEqual(["nadra:pass", "liveness:pass", "sanctions:pass"]);
    expect(await isVerified(db, w)).toBe(true);
    expect(await isVerified(db, w.toUpperCase().replace("0X", "0x"))).toBe(true);
    const v = await statusOf(db, r.subjectId);
    expect(v?.wallet).toBe(w);
    const days = ((v?.validUntil?.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(364);
    expect(days).toBeLessThan(366);
  });

  it("Y-1: no CNIC, name or provider response is stored in readable form anywhere in the kyc schema", async () => {
    const id = cnic();
    const name = "Mehwish Qureshi Testcase";
    await kyc.onboard({ cnic: id, fullName: name, livenessSessionId: "sess-good-0002", wallet: wallet() });
    const digits = id.replaceAll("-", "");
    const needles = [digits, id, name, name.toUpperCase(), "MEHWISH", "QURESHI", Buffer.from("MEHWISH").toString("hex"), digits.slice(0, 9)];
    const { rows: tables } = await db.query<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'kyc'");
    expect(tables.length).toBeGreaterThan(5);
    for (const { t } of tables) {
      const { rows } = await db.query<{ j: string }>(`SELECT row_to_json(x)::text AS j FROM kyc.${t} x`);
      for (const r of rows) for (const n of needles) expect(r.j.toUpperCase(), `${t} contains ${n}`).not.toContain(n.toUpperCase());
    }
  });

  it("Y-2: a CNIC is registered once, with or without dashes, also after a pepper rotation", async () => {
    const id = cnic();
    await kyc.onboard({ cnic: id, fullName: "Hamza Ali", livenessSessionId: "sess-good-0003" });
    await expect(kyc.onboard({ cnic: id.replaceAll("-", ""), fullName: "Hamza Ali", livenessSessionId: "sess-good-0004" })).rejects.toSatisfy(
      (e: unknown) => e instanceof KycError && e.code === "DUPLICATE_CNIC",
    );
    // Rotation: v2 is now current, v1 still active for lookups.
    const rotated = new KycService(pool, providers, Peppers.of([{ version: 2, key: randomBytes(32) }, peppers.current]), dataKey);
    await expect(rotated.onboard({ cnic: id, fullName: "Hamza Ali", livenessSessionId: "sess-good-0005" })).rejects.toSatisfy(
      (e: unknown) => e instanceof KycError && e.code === "DUPLICATE_CNIC",
    );
    // A new person under v2 is registered with both hashes, so a v1-only service also finds them.
    const other = cnic();
    expect((await rotated.onboard({ cnic: other, fullName: "Sana Javed", livenessSessionId: "sess-good-0006" })).status).toBe("verified");
    await expect(kyc.onboard({ cnic: other, fullName: "Sana Javed", livenessSessionId: "sess-good-0007" })).rejects.toThrow(/already registered/);
  });

  it("NADRA not found rejects and stops before the other (paid) checks; liveness spoofing rejects", async () => {
    const before = { l: providers.liveness.calls, s: providers.sanctions.calls };
    const r = await kyc.onboard({ cnic: cnic(0), fullName: "Fake Person", livenessSessionId: "sess-good-0008" });
    expect(r.status).toBe("rejected");
    expect(r.reason).toMatch(/NADRA did not confirm the identity \(not_found\)/);
    expect(providers.liveness.calls).toBe(before.l);
    expect(providers.sanctions.calls).toBe(before.s);
    const spoof = await kyc.onboard({ cnic: cnic(), fullName: "Masked Person", livenessSessionId: "sess-spoof-0001" });
    expect(spoof).toMatchObject({ status: "rejected" });
    expect(spoof.reason).toMatch(/liveness check failed \(spoof_detected\)/);
  });

  it("a provider outage never verifies anyone; the same person can retry later", async () => {
    const id = cnic();
    let down = true;
    const flaky = new KycService(pool, {
      ...providers,
      nadra: { verify: (req) => (down ? Promise.reject(new Error("timeout")) : providers.nadra.verify(req)) },
    }, peppers, dataKey);
    const first = await flaky.onboard({ cnic: id, fullName: "Usman Tariq", livenessSessionId: "sess-good-0009" });
    expect(first).toMatchObject({ status: "pending", checks: [{ kind: "nadra", outcome: "error", reason: "unavailable" }] });
    down = false;
    // Retrying with a different name is refused: it is the same CNIC but not the same person's record.
    await expect(flaky.onboard({ cnic: id, fullName: "Someone Else", livenessSessionId: "sess-good-0010" })).rejects.toThrow(/already registered/);
    const second = await flaky.onboard({ cnic: id, fullName: "usman  tariq", livenessSessionId: "sess-good-0011" });
    expect(second.subjectId).toBe(first.subjectId);
    expect(second.status).toBe("verified");
  });

  it("Y-3 in the database: a liveness pass below 80 cannot be recorded, whatever the service claims", async () => {
    const r = await kyc.onboard({ cnic: cnic(0), fullName: "Low Score", livenessSessionId: "sess-good-0012" });
    const fake: ProviderResult = { kind: "liveness", outcome: "pass", provider: "rogue", providerRef: "rogue-0001", reason: "live", score: 50, evidence: {} };
    await expect(recordCheck(db, r.subjectId, fake, "rogue")).rejects.toThrow(/check constraint/);
    await expect(recordCheck(db, r.subjectId, { ...fake, kind: "nadra", outcome: "review", score: undefined } as unknown as ProviderResult, "rogue")).rejects.toThrow(/check constraint/);
  });
});

describe("sanctions (Y-3, Y-4)", () => {
  it("a possible match goes to review and needs two different officers to clear", async () => {
    const w = wallet();
    const r = await kyc.onboard({ cnic: cnic(), fullName: "Bilal Fictitious Khan", livenessSessionId: "sess-good-0013", wallet: w });
    expect(r.status).toBe("review");
    expect(await isVerified(db, w)).toBe(false); // not bound, and not verified
    const { rows } = await db.query<{ id: string }>("SELECT id FROM kyc.checks WHERE subject_id = $1 AND kind = 'sanctions'", [r.subjectId]);
    const checkId = BigInt(rows[0]?.id ?? "0");
    const req = await requestClearance(db, checkId, "officer:amna", "false_positive", "Different father name and date of birth on NADRA record");
    await expect(requestClearance(db, checkId, "officer:bilal", "true_match", "second request for the same check")).rejects.toThrow(/already has an open/);
    await expect(decideClearance(db, req, "officer:amna", "approve", "approving my own request")).rejects.toThrow(/maker-checker/);
    expect(await decideClearance(db, req, "officer:zainab", "approve", "Checked the list entry: different person")).toBe("approved");
    expect(await subjectStatus(db, r.subjectId)).toBe("verified");
    expect((await statusOf(db, r.subjectId))?.reason).toMatch(/cleared by two officers/);
  });

  it("an exact list hit is final: the person cannot retry, and no later screening reverses it", async () => {
    const id = cnic();
    const r = await kyc.onboard({ cnic: id, fullName: "Zargham Testkhan", livenessSessionId: "sess-good-0014" });
    expect(r).toMatchObject({ status: "rejected", reason: "sanctions match (final)" });
    await expect(kyc.onboard({ cnic: id, fullName: "Zargham Testkhan", livenessSessionId: "sess-good-0015" })).rejects.toThrow(/already registered/);
    const clean: ProviderResult = { kind: "sanctions", outcome: "pass", provider: "mock-sanctions", providerRef: "SCR-later-0001", reason: "clear", score: 0, listVersion: "v2", evidence: {} };
    await recordCheck(db, r.subjectId, clean, "kyc-service");
    expect(await kyc.rescreen(r.subjectId).catch(() => subjectStatus(db, r.subjectId))).toBe("rejected");
  });

  it("re-screening a verified investor: a new possible match removes the verification and raises an alert; an outage does not", async () => {
    const w = wallet();
    const r = await kyc.onboard({ cnic: cnic(), fullName: "Kamran Clean", livenessSessionId: "sess-good-0016", wallet: w });
    expect(r.status).toBe("verified");

    providers.sanctions.unavailable = true;
    try {
      expect(await kyc.rescreen(r.subjectId)).toBe("verified");
    } finally {
      providers.sanctions.unavailable = false;
    }

    const listener = await pool.connect();
    const alerts: string[] = [];
    listener.on("notification", (m) => alerts.push(m.payload ?? ""));
    await listener.query("LISTEN kyc_alert");
    try {
      const listUpdate = new KycService(pool, { ...providers, sanctions: { screen: () => new MockSanctions().screen({ fullName: "Bilal Fictitious Kamran" }) } }, peppers, dataKey);
      expect(await listUpdate.rescreen(r.subjectId)).toBe("review");
      expect(await isVerified(db, w)).toBe(false);
      await new Promise((res) => setTimeout(res, 50));
      expect(alerts.map((a) => JSON.parse(a) as unknown)).toEqual([{ subject: r.subjectId, from: "verified", to: "review" }]);
    } finally {
      await listener.query("UNLISTEN kyc_alert");
      listener.release();
    }
  });

  it("revocation is final and alerts", async () => {
    const w = wallet();
    const r = await kyc.onboard({ cnic: cnic(), fullName: "Faisal Revoked", livenessSessionId: "sess-good-0017", wallet: w });
    await expect(revoke(db, r.subjectId, "officer:amna", "short")).rejects.toThrow(/reason/);
    expect(await revoke(db, r.subjectId, "officer:amna", "Court order received for this investor")).toBe(true);
    expect(await revoke(db, r.subjectId, "officer:amna", "Court order received for this investor")).toBe(false);
    expect(await isVerified(db, w)).toBe(false);
    expect(await kyc.rescreen(r.subjectId)).toBe("revoked");
  });
});

describe("records (Y-5) and roles (Y-6)", () => {
  it("every KYC table refuses UPDATE, DELETE and TRUNCATE, even for the administrator", async () => {
    for (const t of ["audit", "subjects", "cnic_hashes", "wallets", "checks", "decisions"]) {
      await expect(db.query(`UPDATE kyc.${t} SET ${t === "wallets" ? "bound_by" : t === "cnic_hashes" ? "pepper_version" : t === "subjects" ? "created_by" : t === "audit" ? "actor" : t === "checks" ? "recorded_by" : "decided_by"} = ${t === "cnic_hashes" ? "9" : "'x'"}`)).rejects.toThrow(/append-only/);
      await expect(db.query(`DELETE FROM kyc.${t}`)).rejects.toThrow(/append-only/);
      await expect(db.query(`TRUNCATE kyc.${t} CASCADE`)).rejects.toThrow(/append-only/);
    }
    await expect(db.query("DELETE FROM kyc.clearances")).rejects.toThrow(/never deleted/);
    await expect(db.query("UPDATE kyc.clearances SET reason = 'changed afterwards, quietly'")).rejects.toThrow(/decided once/);
  });

  // Builds and drops its own database: on Windows the drop's checkpoint fsyncs every new file (~25 s here).
  it("the audit chain is intact, and a rogue administrator's edits are found", async () => {
    expect(await verifyAudit(db)).toEqual([]);
    const scratch = await scratchDatabase();
    const p = new pg.Pool({ ...scratch.settings, max: 2 });
    try {
      await migrate(scratch.client, MIGRATIONS);
      const k = new KycService(p, providers, peppers, dataKey);
      const ok = await k.onboard({ cnic: cnic(), fullName: "Expiring Person", livenessSessionId: "sess-good-0018" });
      expect(ok.status).toBe("verified");
      // Ageing the verification by hand: the gate sees it as expired ...
      await scratch.client.query("ALTER TABLE kyc.decisions DISABLE TRIGGER decisions_append_only");
      await scratch.client.query("UPDATE kyc.decisions SET valid_until = now() - interval '1 day' WHERE subject_id = $1", [ok.subjectId]);
      await scratch.client.query("ALTER TABLE kyc.decisions ENABLE TRIGGER decisions_append_only");
      expect(await subjectStatus(scratch.client, ok.subjectId)).toBe("expired");
      // ... and the audit log notices that a decision was changed after it was made.
      expect((await verifyAudit(scratch.client)).map((x) => x.problem)).toEqual([expect.stringMatching(/decision \d+ changed after it was made/)]);
      // Checks older than 30 days cannot start a new verification.
      await scratch.client.query("ALTER TABLE kyc.checks DISABLE TRIGGER checks_append_only");
      await scratch.client.query("UPDATE kyc.checks SET at = at - interval '31 days' WHERE subject_id = $1", [ok.subjectId]);
      await scratch.client.query("ALTER TABLE kyc.checks ENABLE TRIGGER checks_append_only");
      expect(await scratch.client.query("SELECT kyc.evaluate($1, 'test') AS s", [ok.subjectId]).then((r) => (r.rows[0] as { s: string }).s)).toBe("pending");
      // A decision inserted around the API has no audit entry.
      await scratch.client.query("INSERT INTO kyc.decisions (subject_id, status, reason, basis, valid_until, decided_by) VALUES ($1, 'verified', 'inserted directly', '{}', now() + interval '1 year', 'dba')", [ok.subjectId]);
      expect((await verifyAudit(scratch.client)).some((x) => /decision \d+ has no audit entry/.test(x.problem))).toBe(true);
    } finally {
      await p.end();
      await scratch.drop();
    }
  }, 120_000);

  it("roles: readers see status only; the service cannot revoke or clear; nobody writes tables directly", async () => {
    const asRole = async (role: string, sql: string, params: unknown[] = []): Promise<unknown> => {
      await db.query("BEGIN");
      try {
        await db.query(`SET LOCAL ROLE ${role}`);
        return (await db.query(sql, params)).rows;
      } finally {
        await db.query("ROLLBACK");
      }
    };
    await expect(asRole("pt_kyc_reader", "SELECT count(*) FROM kyc.status")).resolves.toBeDefined();
    await expect(asRole("pt_kyc_reader", "SELECT count(*) FROM kyc.subjects")).rejects.toThrow(/permission denied/);
    await expect(asRole("pt_kyc_reader", "SELECT * FROM kyc.sealed_name(gen_random_uuid())")).rejects.toThrow(/permission denied/);
    await expect(asRole("pt_kyc_service", "SELECT count(*) FROM kyc.checks")).rejects.toThrow(/permission denied/);
    await expect(asRole("pt_kyc_service", "SELECT kyc.revoke(gen_random_uuid(), 'svc', 'trying to revoke as the service')")).rejects.toThrow(/permission denied/);
    await expect(asRole("pt_kyc_service", "INSERT INTO kyc.decisions (subject_id, status, reason, basis, decided_by) VALUES (gen_random_uuid(), 'pending', 'xx', '{}', 'svc')")).rejects.toThrow(/permission denied/);
    await expect(asRole("pt_kyc_officer", "SELECT kyc.register_subject(ARRAY[]::bytea[], ARRAY[]::smallint[], ''::bytea, ''::bytea, '0000', 'x')")).rejects.toThrow(/permission denied/);
    await expect(asRole("pt_signer", "SELECT kyc.is_verified('0x0000000000000000000000000000000000000000')")).resolves.toEqual([{ is_verified: false }]);
  });
});
