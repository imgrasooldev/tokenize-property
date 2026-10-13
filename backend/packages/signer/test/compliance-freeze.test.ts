import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KycService, mockProviders, Peppers, revoke } from "@pt/kyc";
import pg from "pg";
import { decodeFunctionData, getAddress, parseTransaction, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { freezeGuardAbi } from "@pt/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { contiguousMigrations, scratchDatabase } from "../../db/test/helpers.ts";
import { officer, type TestOfficer } from "../../db/test/officers.ts";
import { FileKeystore, writeKeyFile } from "../src/keystore.ts";
import { SignerService, type ChainReader } from "../src/service.ts";

/**
 * Step 6c (migration 0019 C-3) end to end without a chain: a compliance officer proposes a freeze in
 * the portal, a second one approves; the hold makes the investor "suspended", so the existing
 * compliance.freeze policy (never a verified investor) signs FreezeGuard.freezeAddress for the
 * command the approval put in the outbox. The unfreeze is the same two-officer path and the new
 * compliance.unfreeze kind signs only what the database confirms (compliance.unfreeze_allowed).
 */
const PASS = "a-long-local-test-passphrase-0123456789";
const A = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
const FREEZE_GUARD = A(0xf1);
let db: pg.Client;
let portal: pg.Client;
let pool: pg.Pool;
let drop: () => Promise<void>;
let kyc: KycService;
let keys: FileKeystore;
let compA: TestOfficer;
let compB: TestOfficer;
let seq = 7000;
const frozen = new Set<string>();
const chain: ChainReader = {
  chainId: () => Promise.resolve(586586),
  pendingNonce: () => Promise.resolve(0n),
  simulate: () => Promise.resolve(),
  mintFacts: () => Promise.reject(new Error("not used")),
  txState: () => Promise.resolve("pending"),
  isFrozen: (_r, account) => Promise.resolve(frozen.has(account.toLowerCase())),
  distribution: () => Promise.reject(new Error("not used")),
};
const svc = (): SignerService => new SignerService(pool, keys, chain);

async function policy(kind: string): Promise<void> {
  const rule = { chainId: 586586, keyRef: "ops", freezeGuard: FREEZE_GUARD, token: A(2), maxPerDay: 20, approvals: 0 };
  const { rows } = await db.query<{ id: string }>("SELECT signer.propose_policy($1, $2::jsonb, 'maker') AS id", [kind, JSON.stringify(rule)]);
  await db.query("SELECT signer.approve_policy($1, 'checker')", [rows[0]?.id]);
}

beforeAll(async () => {
  let settings: pg.ClientConfig;
  ({ client: db, settings, drop } = await scratchDatabase());
  await migrate(db, contiguousMigrations());
  pool = new pg.Pool({ ...settings, max: 8 });
  portal = new pg.Client(settings);
  await portal.connect();
  await portal.query("SET ROLE pt_admin_portal");
  kyc = new KycService(pool, mockProviders(), Peppers.of([{ version: 1, key: randomBytes(32) }]), randomBytes(32));
  const dir = await mkdtemp(join(tmpdir(), "ks-"));
  await writeKeyFile(dir, "ops", generatePrivateKey(), PASS);
  keys = await FileKeystore.open(dir, PASS);
  await db.query("INSERT INTO signer.keys (key_ref, address, purpose) VALUES ('ops', $1, 'test')", [keys.address("ops")]);
  compA = await officer(db, "comp.freeze.a", "compliance_officer");
  compB = await officer(db, "comp.freeze.b", "compliance_officer");
}, 180_000);

afterAll(async () => {
  await portal.end();
  await pool.end();
  await drop();
}, 180_000);

async function investor(): Promise<{ subjectId: string; wallet: Hex }> {
  const wallet: Hex = `0x${randomBytes(20).toString("hex")}`;
  const r = await kyc.onboard({ cnic: `4220${String(10_000_000 + ++seq).slice(-8)}2`, fullName: "Freeze Subject", livenessSessionId: `sess-cfz-${String(seq)}`, wallet });
  expect(r.status).toBe("verified");
  return { subjectId: r.subjectId, wallet };
}

type R = { ok: boolean; id?: number; status?: string; error?: string };

async function request(o: TestOfficer, kind: "freeze" | "unfreeze", wallet: string, code: string): Promise<R> {
  const { rows } = await portal.query<{ r: R }>("SELECT admin.request_freeze($1, $2, $3, $4, $5, NULL, NULL) AS r", [
    o.sessionHash,
    kind,
    wallet,
    code,
    kind === "freeze" ? "court order received from the district court" : "court order lifted by the district court",
  ]);
  return rows[0]?.r ?? { ok: false };
}

async function decide(o: TestOfficer, id: number, decision: "approve" | "reject"): Promise<R> {
  const d = await portal.query<{ v: { digest: string } }>("SELECT admin.freeze_request($1, $2) AS v", [o.sessionHash, id]);
  const { rows } = await portal.query<{ r: R }>("SELECT admin.decide_freeze($1, $2, $3, 'order checked against the court record', $4) AS r", [
    o.sessionHash,
    id,
    decision,
    Buffer.from(d.rows[0]?.v.digest ?? "", "hex"),
  ]);
  return rows[0]?.r ?? { ok: false };
}

async function command(key: string): Promise<{ kind: string; payload: { freezeGuard: string; account: string; caseId: string } }> {
  const { rows } = await db.query<{ kind: string; payload: { freezeGuard: string; account: string; caseId: string } }>(
    "SELECT kind, payload FROM outbox.commands WHERE idempotency_key = $1",
    [key],
  );
  if (!rows[0]) throw new Error(`no outbox command ${key}`);
  return rows[0];
}

describe("compliance freeze and unfreeze (C-3)", () => {
  it("refuses an approval while no freeze signing policy is active", async () => {
    const o = await investor();
    const r = await request(compA, "freeze", o.wallet, "court_order");
    expect(r.ok).toBe(true);
    expect(await decide(compB, r.id ?? 0, "approve")).toMatchObject({ ok: false, error: expect.stringMatching(/no active compliance.freeze signing policy/) as unknown });
    expect(await decide(compB, r.id ?? 0, "reject")).toMatchObject({ ok: true, status: "rejected" });
    await policy("compliance.freeze");
    await policy("compliance.unfreeze");
  });

  it("two officers freeze; the hold suspends the investor; the signer signs freezeAddress for the queued command", async () => {
    const o = await investor();
    expect((await request(compA, "freeze", o.wallet, "unfreeze_reason_wrong")).error).toMatch(/not a freeze reason/);
    const r = await request(compA, "freeze", o.wallet, "court_order");
    expect(r.ok).toBe(true);
    const id = r.id ?? 0;
    // One open request per wallet; the proposer never decides.
    expect((await request(compB, "freeze", o.wallet, "fraud_suspected")).error).toMatch(/open freeze or unfreeze request/);
    expect(await decide(compA, id, "approve")).toMatchObject({ ok: false, error: expect.stringMatching(/maker-checker/) as unknown });
    // A changed request (what you see is what you decide).
    const stale = await portal.query<{ r: R }>("SELECT admin.decide_freeze($1, $2, 'approve', 'order checked against the court record', $3) AS r", [compB.sessionHash, id, Buffer.alloc(32)]);
    expect(stale.rows[0]?.r.error).toMatch(/differs from what you reviewed/);

    expect(await decide(compB, id, "approve")).toMatchObject({ ok: true, status: "approved" });
    expect((await db.query<{ s: string }>("SELECT kyc.subject_status($1) AS s", [o.subjectId])).rows[0]?.s).toBe("suspended");
    expect((await db.query<{ s: string }>("SELECT kyc.underlying_status($1) AS s", [o.subjectId])).rows[0]?.s).toBe("verified");
    const cmd = await command(`compliance.freeze:request:${String(id)}`);
    expect(cmd).toMatchObject({ kind: "compliance.freeze", payload: { freezeGuard: FREEZE_GUARD, account: o.wallet } });
    expect(cmd.payload.caseId).toMatch(/^0x[0-9a-f]{64}$/);

    const signed = await svc().request({ commandRef: `compliance.freeze:request:${String(id)}`, kind: "compliance.freeze", payload: cmd.payload }, "outbox-worker");
    expect(signed.status).toBe("signed");
    const tx = parseTransaction((signed as { raw: Hex }).raw);
    expect(tx.to).toBe(FREEZE_GUARD);
    const call = decodeFunctionData({ abi: freezeGuardAbi, data: tx.data ?? "0x" });
    expect(call).toMatchObject({ functionName: "freezeAddress", args: [getAddress(o.wallet), cmd.payload.caseId] });
    frozen.add(o.wallet);
    // Offboarding does not double it: a suspended investor is not in the offboarding list.
    expect((await db.query<{ n: number }>("SELECT kyc.enqueue_offboarding($1, 'kyc-offboarding') AS n", [FREEZE_GUARD])).rows[0]?.n).toBe(0);

    // A forged unfreeze (no two-officer decision) is denied by the signer.
    const forged = await svc().request({ commandRef: `compliance.unfreeze:forged:${String(id)}`, kind: "compliance.unfreeze", payload: cmd.payload }, "outbox-worker");
    expect(forged).toMatchObject({ status: "denied", reason: expect.stringMatching(/no approved two-officer unfreeze/) as unknown });

    // Unfreeze: two officers again; the hold is lifted and the new kind signs unfreezeAddress.
    const u = await request(compB, "unfreeze", o.wallet, "court_release");
    expect(u.ok).toBe(true);
    expect(await decide(compB, u.id ?? 0, "approve")).toMatchObject({ ok: false, error: expect.stringMatching(/maker-checker/) as unknown });
    expect(await decide(compA, u.id ?? 0, "approve")).toMatchObject({ ok: true, status: "approved" });
    expect((await db.query<{ s: string }>("SELECT kyc.subject_status($1) AS s", [o.subjectId])).rows[0]?.s).toBe("verified");
    const ucmd = await command(`compliance.unfreeze:request:${String(u.id)}`);
    expect(ucmd.payload.caseId).not.toBe(cmd.payload.caseId);
    const unsigned = await svc().request({ commandRef: `compliance.unfreeze:request:${String(u.id)}`, kind: "compliance.unfreeze", payload: ucmd.payload }, "outbox-worker");
    expect(unsigned.status).toBe("signed");
    const utx = parseTransaction((unsigned as { raw: Hex }).raw);
    expect(decodeFunctionData({ abi: freezeGuardAbi, data: utx.data ?? "0x" }).functionName).toBe("unfreezeAddress");
    frozen.delete(o.wallet);
    // The old freeze caseId never unfreezes, and a not-frozen wallet is not "unfrozen" again.
    expect(await svc().request({ commandRef: `compliance.unfreeze:again:${String(u.id)}`, kind: "compliance.unfreeze", payload: ucmd.payload }, "outbox-worker")).toMatchObject({
      status: "denied",
      reason: /not frozen/,
    });
  });

  it("an unfreeze is refused while the investor's own KYC status is not verified", async () => {
    const o = await investor();
    const f = await request(compA, "freeze", o.wallet, "sanctions_match");
    expect(await decide(compB, f.id ?? 0, "approve")).toMatchObject({ ok: true });
    await revoke(db, o.subjectId, "officer:night", "revoked after the sanctions review");
    const u = await request(compA, "unfreeze", o.wallet, "error_correction");
    const detail = await portal.query<{ v: { approveBlockers: string[] } }>("SELECT admin.freeze_request($1, $2) AS v", [compB.sessionHash, u.id]);
    expect(detail.rows[0]?.v.approveBlockers.join(" ")).toMatch(/KYC status is revoked/);
    expect(await decide(compB, u.id ?? 0, "approve")).toMatchObject({ ok: false, error: expect.stringMatching(/not KYC-verified \(revoked\)/) as unknown });
  });

  it("the trail is complete: compliance, admin and KYC audit chains verify", async () => {
    expect((await db.query("SELECT * FROM compliance.verify_audit()")).rows).toEqual([]);
    expect((await db.query("SELECT * FROM admin.verify_audit()")).rows).toEqual([]);
    expect((await db.query("SELECT * FROM signer.verify_audit()")).rows).toEqual([]);
    const actions = (await db.query<{ action: string }>("SELECT DISTINCT action FROM compliance.audit")).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["freeze.requested", "freeze.decided"]));
  });
});
