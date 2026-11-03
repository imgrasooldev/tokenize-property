import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KycService, mockProviders, Peppers } from "@pt/kyc";
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
 * Migration 0054 end to end without a chain: two compliance officers freeze an AMOUNT of a wallet
 * (PF-1, PF-2); the investor stays verified (PF-3); the new kind compliance.freeze_partial signs
 * FreezeGuard.freezePartial only for the command the approval enqueued, once (PF-4); a release lifts
 * the whole partial hold once its freeze is on chain; reconciliation reports what does not match (PF-5).
 */
const PASS = "a-long-local-test-passphrase-0123456789";
const A = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
const FREEZE_GUARD = A(0xf2);
const TOKEN = A(0x7a);
const DEPLOYMENT = "dep-partial";
let db: pg.Client;
let portal: pg.Client;
let pool: pg.Pool;
let drop: () => Promise<void>;
let kyc: KycService;
let keys: FileKeystore;
let compA: TestOfficer;
let compB: TestOfficer;
let seq = 8000;
const balances = new Map<string, bigint>();
const frozenUnits = new Map<string, bigint>();
const chain: ChainReader = {
  chainId: () => Promise.resolve(586586),
  pendingNonce: () => Promise.resolve(0n),
  simulate: () => Promise.resolve(),
  mintFacts: () => Promise.reject(new Error("not used")),
  txState: () => Promise.resolve("pending"),
  isFrozen: () => Promise.resolve(false),
  distribution: () => Promise.reject(new Error("not used")),
  balanceOf: (_t, w) => Promise.resolve(balances.get(w.toLowerCase()) ?? 0n),
  holderFreeze: (_t, w) => Promise.resolve({ frozen: false, frozenTokens: frozenUnits.get(w.toLowerCase()) ?? 0n }),
};
const svc = (): SignerService => new SignerService(pool, keys, chain);

async function policy(kind: string): Promise<void> {
  const rule = { chainId: 586586, keyRef: "ops", freezeGuard: FREEZE_GUARD, token: TOKEN, maxPerDay: 20, approvals: 0 };
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
  compA = await officer(db, "comp.partial.a", "compliance_officer");
  compB = await officer(db, "comp.partial.b", "compliance_officer");
  await db.query("SELECT chain.register_deployment($1, 586586, 0, $2::jsonb, NULL)", [DEPLOYMENT, JSON.stringify({ token: TOKEN, issuance: A(0x7b), identityRegistry: A(0x7c) })]);
}, 180_000);

afterAll(async () => {
  await portal.end();
  await pool.end();
  await drop();
}, 180_000);

/** A verified investor holding `units` of the token (read model and fake chain). */
async function investor(units: bigint): Promise<{ subjectId: string; wallet: Hex }> {
  const wallet: Hex = `0x${randomBytes(20).toString("hex")}`;
  const r = await kyc.onboard({ cnic: `4220${String(10_000_000 + ++seq).slice(-8)}3`, fullName: "Partial Subject", livenessSessionId: `sess-cpf-${String(seq)}`, wallet });
  expect(r.status).toBe("verified");
  await db.query("INSERT INTO chain.holdings (token, holder, balance, updated_block) VALUES ($1, $2, $3, 1)", [TOKEN, wallet, units.toString()]);
  balances.set(wallet, units);
  return { subjectId: r.subjectId, wallet };
}

let block = 100;
let logIndex = 0;
/** The indexer saw FreezeGuard.PartialFreezeSet (and the token's TokensFrozen / TokensUnfrozen). */
async function onChain(wallet: string, amount: bigint, frozen: boolean, caseId: string): Promise<void> {
  const hash = `0x${randomBytes(32).toString("hex")}`;
  block += 1;
  await db.query("INSERT INTO chain.blocks (number, hash, parent_hash, block_time) VALUES ($1, $2, $3, now())", [block, hash, `0x${randomBytes(32).toString("hex")}`]);
  await db.query(
    `INSERT INTO chain.events (deployment, block_number, log_index, block_hash, tx_hash, tx_index, address, contract, name, args, topics, data)
     VALUES ($1, $2, $3, $4, $5, 0, $6, 'freezeGuard', NULL, NULL, '{}', '0x')`,
    [DEPLOYMENT, block, ++logIndex, hash, hash, FREEZE_GUARD],
  );
  await db.query("INSERT INTO chain.freeze_actions (deployment, block_number, log_index, guard, holder, scope, frozen, amount, case_id) VALUES ($1, $2, $3, $4, $5, 'partial', $6, $7, $8)", [
    DEPLOYMENT, block, logIndex, FREEZE_GUARD, wallet, frozen, amount.toString(), caseId,
  ]);
  const next = (frozenUnits.get(wallet) ?? 0n) + (frozen ? amount : -amount);
  frozenUnits.set(wallet, next);
  await db.query(
    `INSERT INTO chain.freezes (token, holder, frozen_amount, updated_block) VALUES ($1, $2, $3, $4)
     ON CONFLICT (token, holder) DO UPDATE SET frozen_amount = EXCLUDED.frozen_amount, updated_block = EXCLUDED.updated_block`,
    [TOKEN, wallet, next.toString(), block],
  );
}

type R = { ok: boolean; id?: number; status?: string; error?: string };

async function request(o: TestOfficer, kind: "freeze" | "unfreeze", wallet: string, amount: bigint | null, lifts: number | null, code: string): Promise<R> {
  const { rows } = await portal.query<{ r: R }>("SELECT admin.request_partial_freeze($1, $2, $3, $4, $5, $6, $7, NULL, NULL) AS r", [
    o.sessionHash,
    kind,
    wallet,
    amount?.toString() ?? null,
    lifts,
    code,
    kind === "freeze" ? "subscription may have to be reversed: protective hold" : "reversal settled by the trustee decision",
  ]);
  return rows[0]?.r ?? { ok: false };
}

async function decide(o: TestOfficer, id: number, decision: "approve" | "reject"): Promise<R> {
  const d = await portal.query<{ v: { digest: string } }>("SELECT admin.partial_freeze($1, $2) AS v", [o.sessionHash, id]);
  const { rows } = await portal.query<{ r: R }>("SELECT admin.decide_partial_freeze($1, $2, $3, 'units checked against the subscription', $4) AS r", [
    o.sessionHash,
    id,
    decision,
    Buffer.from(d.rows[0]?.v.digest ?? "", "hex"),
  ]);
  return rows[0]?.r ?? { ok: false };
}

type Payload = { freezeGuard: string; account: string; amount: string; caseId: string };
async function command(key: string): Promise<{ kind: string; payload: Payload }> {
  const { rows } = await db.query<{ kind: string; payload: Payload }>("SELECT kind, payload FROM outbox.commands WHERE idempotency_key = $1", [key]);
  if (!rows[0]) throw new Error(`no outbox command ${key}`);
  return rows[0];
}

const recon = async () =>
  (await db.query<{ check_name: string; subject: string; actual: string }>("SELECT check_name, subject, actual FROM recon.compliance_partial($1)", [TOKEN])).rows;

describe("compliance partial freeze (migration 0054)", () => {
  it("refuses a proposal while no compliance.freeze_partial signing policy is active", async () => {
    const o = await investor(100n);
    expect((await request(compA, "freeze", o.wallet, 10n, null, "reversal_review")).error).toMatch(/no active compliance.freeze_partial signing policy/);
    await policy("compliance.freeze_partial");
    await policy("compliance.unfreeze_partial");
  });

  it("two officers freeze an amount; the investor stays verified; the signer signs freezePartial once", async () => {
    const o = await investor(100n);
    expect((await request(compA, "freeze", o.wallet, 101n, null, "reversal_review")).error).toMatch(/only 100 units of this wallet are free/);
    expect((await request(compA, "freeze", o.wallet, 0n, null, "reversal_review")).error).toMatch(/whole number of token units above 0/);
    expect((await request(compA, "freeze", o.wallet, 10n, null, "court_release")).error).toMatch(/not a freeze reason/);
    const r = await request(compA, "freeze", o.wallet, 40n, null, "reversal_review");
    expect(r.ok).toBe(true);
    const id = r.id ?? 0;
    expect((await request(compB, "freeze", o.wallet, 5n, null, "court_order")).error).toMatch(/open partial freeze or release request/);
    expect(await decide(compA, id, "approve")).toMatchObject({ ok: false, error: expect.stringMatching(/maker-checker/) as unknown });
    const stale = await portal.query<{ r: R }>("SELECT admin.decide_partial_freeze($1, $2, 'approve', 'units checked against the subscription', $3) AS r", [
      compB.sessionHash, id, Buffer.alloc(32),
    ]);
    expect(stale.rows[0]?.r.error).toMatch(/differs from what you reviewed/);

    expect(await decide(compB, id, "approve")).toMatchObject({ ok: true, status: "approved" });
    // PF-3: no compliance hold, the investor is still verified.
    expect((await db.query<{ s: string }>("SELECT kyc.subject_status($1) AS s", [o.subjectId])).rows[0]?.s).toBe("verified");
    const cmd = await command(`compliance.freeze_partial:request:${String(id)}`);
    expect(cmd).toMatchObject({ kind: "compliance.freeze_partial", payload: { freezeGuard: FREEZE_GUARD, account: o.wallet, amount: "40" } });

    // A changed amount or a forged command ref with the same payload: only the enqueued payload passes.
    const forged = await svc().request({ commandRef: `compliance.freeze_partial:forged:${String(id)}`, kind: "compliance.freeze_partial", payload: { ...cmd.payload, amount: "60" } }, "outbox-worker");
    expect(forged).toMatchObject({ status: "denied", reason: expect.stringMatching(/no approved two-officer partial freeze/) as unknown });
    const signed = await svc().request({ commandRef: `compliance.freeze_partial:request:${String(id)}`, kind: "compliance.freeze_partial", payload: cmd.payload }, "outbox-worker");
    expect(signed.status).toBe("signed");
    const tx = parseTransaction((signed as { raw: Hex }).raw);
    expect(tx.to).toBe(FREEZE_GUARD);
    expect(decodeFunctionData({ abi: freezeGuardAbi, data: tx.data ?? "0x" })).toMatchObject({ functionName: "freezePartial", args: [getAddress(o.wallet), 40n, cmd.payload.caseId] });

    // PF-2: 40 approved units count against the free balance before they are on chain.
    expect((await request(compA, "freeze", o.wallet, 61n, null, "reversal_review")).error).toMatch(/only 60 units/);
    // PF-3: a release only once the freeze is on chain.
    expect((await request(compB, "unfreeze", o.wallet, null, id, "reversal_settled")).error).toMatch(/not on chain yet/);

    await onChain(o.wallet, 40n, true, cmd.payload.caseId);
    // PF-4: never replayed once on chain.
    const again = await svc().request({ commandRef: `compliance.freeze_partial:again:${String(id)}`, kind: "compliance.freeze_partial", payload: cmd.payload }, "outbox-worker");
    expect(again).toMatchObject({ status: "denied", reason: expect.stringMatching(/already on chain/) as unknown });
    expect(await recon()).toEqual([]);

    // Release: the whole hold, two officers again, the new kind signs unfreezePartial.
    expect((await request(compB, "unfreeze", o.wallet, 10n, id, "reversal_settled")).error).toMatch(/whole partial hold \(40 units\)/);
    const u = await request(compB, "unfreeze", o.wallet, null, id, "reversal_settled");
    expect(u.ok).toBe(true);
    expect(await decide(compA, u.id ?? 0, "approve")).toMatchObject({ ok: true, status: "approved" });
    const ucmd = await command(`compliance.unfreeze_partial:request:${String(u.id)}`);
    expect(ucmd.payload).toMatchObject({ amount: "40" });
    expect(ucmd.payload.caseId).not.toBe(cmd.payload.caseId);
    frozenUnits.set(o.wallet, 0n);
    expect(await svc().request({ commandRef: `compliance.unfreeze_partial:early:${String(u.id)}`, kind: "compliance.unfreeze_partial", payload: ucmd.payload }, "outbox-worker")).toMatchObject({
      status: "denied",
      reason: /fewer tokens are frozen on chain/,
    });
    frozenUnits.set(o.wallet, 40n);
    const unsigned = await svc().request({ commandRef: `compliance.unfreeze_partial:request:${String(u.id)}`, kind: "compliance.unfreeze_partial", payload: ucmd.payload }, "outbox-worker");
    expect(unsigned.status).toBe("signed");
    const utx = parseTransaction((unsigned as { raw: Hex }).raw);
    expect(decodeFunctionData({ abi: freezeGuardAbi, data: utx.data ?? "0x" })).toMatchObject({ functionName: "unfreezePartial", args: [getAddress(o.wallet), 40n, ucmd.payload.caseId] });
    await onChain(o.wallet, 40n, false, ucmd.payload.caseId);
    expect((await request(compA, "unfreeze", o.wallet, null, id, "reversal_settled")).error).toMatch(/holds nothing in this wallet to release/);
    expect(await recon()).toEqual([]);
  });

  it("reconciliation: an unmatched partial freeze on chain is blocking, an approved one not on chain after an hour is pending", async () => {
    const o = await investor(50n);
    await onChain(o.wallet, 7n, true, `0x${"ab".repeat(32)}`);
    const r = await request(compA, "freeze", o.wallet, 5n, null, "court_order");
    expect(await decide(compB, r.id ?? 0, "approve")).toMatchObject({ ok: true });
    await db.query("SET session_replication_role = replica"); // test only: age the decision past the guard trigger
    await db.query("UPDATE compliance.partial_freeze_requests SET decided_at = decided_at - interval '2 hours' WHERE id = $1", [r.id]);
    await db.query("SET session_replication_role = DEFAULT");
    const findings = await recon();
    expect(findings.map((f) => f.check_name).sort()).toEqual(["compliance.partial_pending", "compliance.partial_unmatched"]);
    expect(findings.find((f) => f.check_name === "compliance.partial_unmatched")?.actual).toMatch(/freeze 7 units/);
  });

  it("the trail is complete: compliance, admin and signer audit chains verify", async () => {
    expect((await db.query("SELECT * FROM compliance.verify_audit()")).rows).toEqual([]);
    expect((await db.query("SELECT * FROM admin.verify_audit()")).rows).toEqual([]);
    expect((await db.query("SELECT * FROM signer.verify_audit()")).rows).toEqual([]);
    const actions = (await db.query<{ action: string }>("SELECT DISTINCT action FROM compliance.audit")).rows.map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(["partial_freeze.requested", "partial_freeze.decided"]));
  });
});
