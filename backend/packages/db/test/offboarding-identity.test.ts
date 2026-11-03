import { randomBytes } from "node:crypto";
import { KycService, mockProviders, Peppers, revoke } from "@pt/kyc";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import { contiguousMigrations, scratchDatabase } from "./helpers.ts";
import { officer, type TestOfficer } from "./officers.ts";

/**
 * Migration 0055 OB-1..OB-3: offboarding step 3 in PT Control. Only for an investor who is not
 * verified, whose wallet holds zero units in every token and still has a registered identity; one
 * compliance officer requests, a different one approves; the approved request carries the timelock
 * call (IdentityRegistry.deleteIdentity) and reads "done" once the read model shows it removed.
 */
const A = (n: number): string => `0x${n.toString(16).padStart(40, "0")}`;
const TOKEN = A(0x91);
const REGISTRY = A(0x92);
const TIMELOCK = A(0x93);
let db: pg.Client;
let portal: pg.Client;
let pool: pg.Pool;
let drop: () => Promise<void>;
let kyc: KycService;
let compA: TestOfficer;
let compB: TestOfficer;
let seq = 0;
let counter = Date.now();

beforeAll(async () => {
  let settings: pg.ClientConfig;
  ({ client: db, settings, drop } = await scratchDatabase());
  await migrate(db, contiguousMigrations());
  pool = new pg.Pool({ ...settings, max: 4 });
  portal = new pg.Client(settings);
  await portal.connect();
  await portal.query("SET ROLE pt_admin_portal");
  kyc = new KycService(pool, mockProviders(), Peppers.of([{ version: 1, key: randomBytes(32) }]), randomBytes(32));
  compA = await officer(db, "comp.offboard.a", "compliance_officer");
  compB = await officer(db, "comp.offboard.b", "compliance_officer");
  await db.query("SELECT chain.register_deployment('dep-offboard', 586586, 0, $1::jsonb, NULL)", [
    JSON.stringify({ token: TOKEN, issuance: A(0x94), identityRegistry: REGISTRY, timelock: TIMELOCK }),
  ]);
}, 180_000);

afterAll(async () => {
  await portal.end();
  await pool.end();
  await drop();
}, 180_000);

/** A revoked investor whose wallet has an identity on chain and `units` of the token. */
async function offboarded(units: number): Promise<{ subjectId: string; wallet: string }> {
  const wallet = `0x${randomBytes(20).toString("hex")}`;
  const r = await kyc.onboard({ cnic: `4220${String(20_000_000 + ++seq).slice(-8)}4`, fullName: "Offboard Subject", livenessSessionId: `sess-obd-${String(seq)}`, wallet });
  await revoke(db, r.subjectId, "officer:night", "revoked after the sanctions review");
  await db.query("INSERT INTO chain.investors (registry, wallet, identity, registered, updated_block) VALUES ($1, $2, $3, true, 1)", [REGISTRY, wallet, A(0x1000 + seq)]);
  await db.query("INSERT INTO chain.holdings (token, holder, balance, updated_block) VALUES ($1, $2, $3, 1)", [TOKEN, wallet, units]);
  return { subjectId: r.subjectId, wallet };
}

type R = { ok: boolean; id?: number; status?: string; error?: string };
async function stepUp(o: TestOfficer): Promise<void> {
  await portal.query("SELECT admin.record_step_up($1, $2, $3)", [o.sessionHash, o.credentialId, ++counter]);
}
async function request(o: TestOfficer, wallet: string): Promise<R> {
  await stepUp(o);
  const { rows } = await portal.query<{ r: R }>("SELECT admin.request_identity_deletion($1, $2, 'units moved under the court order, offboarding') AS r", [o.sessionHash, wallet]);
  return rows[0]?.r ?? { ok: false };
}
type Detail = { digest: string; status: string; callData: string | null; timelock: string | null; registry: string; blockers: string[]; approveBlockers: string[] };
async function detail(o: TestOfficer, id: number): Promise<Detail> {
  const { rows } = await portal.query<{ v: Detail }>("SELECT admin.identity_deletion($1, $2) AS v", [o.sessionHash, id]);
  if (!rows[0]) throw new Error("no detail");
  return rows[0].v;
}
async function decide(o: TestOfficer, id: number, decision: "approve" | "reject"): Promise<R> {
  const d = await detail(o, id);
  await stepUp(o);
  const { rows } = await portal.query<{ r: R }>("SELECT admin.decide_identity_deletion($1, $2, $3, 'zero units checked on the read model', $4) AS r", [
    o.sessionHash, id, decision, Buffer.from(d.digest, "hex"),
  ]);
  return rows[0]?.r ?? { ok: false };
}

describe("offboarding step 3: identity deletion (migration 0055)", () => {
  it("refused while the wallet holds units or for a verified investor; two officers; the timelock call; done when the identity is gone", async () => {
    const o = await offboarded(25);
    expect((await request(compA, o.wallet)).error).toMatch(/still holds 25 units: move or redeem them first/);
    const list = await portal.query<{ v: { investors: { wallet: string; units: string; registered: boolean }[] } }>("SELECT admin.offboarding($1) AS v", [compA.sessionHash]);
    expect(list.rows[0]?.v.investors.find((x) => x.wallet === o.wallet)).toMatchObject({ units: "25", registered: true });

    // Step 2 happened elsewhere (S-06 / S-04): the read model now shows zero.
    await db.query("UPDATE chain.holdings SET balance = 0 WHERE holder = $1", [o.wallet]);
    const r = await request(compA, o.wallet);
    expect(r).toMatchObject({ ok: true, status: "open" });
    const id = r.id ?? 0;
    expect((await request(compB, o.wallet)).error).toMatch(/open or approved identity deletion exists/);
    expect((await detail(compA, id)).blockers.join(" ")).toMatch(/You requested this deletion/);
    expect((await decide(compA, id, "approve")).error).toMatch(/maker-checker/);
    expect(await decide(compB, id, "approve")).toMatchObject({ ok: true, status: "approved" });
    const d = await detail(compB, id);
    expect(d).toMatchObject({ status: "approved", registry: REGISTRY, timelock: TIMELOCK, callData: `0xa8d29d1d${o.wallet.slice(2).padStart(64, "0")}` });

    await db.query("UPDATE chain.investors SET registered = false, identity = NULL WHERE wallet = $1", [o.wallet]);
    expect((await detail(compB, id)).status).toBe("done");
  });

  it("never for a verified investor; never edited; the audit chains verify", async () => {
    const wallet = `0x${randomBytes(20).toString("hex")}`;
    const v = await kyc.onboard({ cnic: `4220${String(20_000_000 + ++seq).slice(-8)}5`, fullName: "Verified Holder", livenessSessionId: `sess-obd-${String(seq)}`, wallet });
    expect(v.status).toBe("verified");
    await db.query("INSERT INTO chain.investors (registry, wallet, identity, registered, updated_block) VALUES ($1, $2, $3, true, 1)", [REGISTRY, wallet, A(0x2000)]);
    expect((await request(compA, wallet)).error).toMatch(/KYC-verified: identities of verified investors are never deleted/);
    await expect(db.query("UPDATE compliance.identity_deletions SET wallet = registry")).rejects.toThrow(/decided once/);
    expect((await db.query("SELECT * FROM compliance.verify_audit()")).rows).toEqual([]);
    expect((await db.query("SELECT * FROM admin.verify_audit()")).rows).toEqual([]);
    // Auditors read; they cannot request.
    const auditor = await officer(db, "audit.offboard", "auditor");
    expect(await portal.query("SELECT admin.offboarding($1)", [auditor.sessionHash]).then(() => "ok")).toBe("ok");
    expect(await portal.query("SELECT admin.request_identity_deletion($1, $2, 'auditor probe text here')", [auditor.sessionHash, wallet]).catch((e: unknown) => (e as { code?: string }).code)).toBe("42501");
  });
});
