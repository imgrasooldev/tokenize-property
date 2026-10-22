import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { investor } from "../support/compliance";
import { operationsWorld, type OperationsWorld } from "../support/operations";
import { cast, createWorld, invite, verify, type Actor, type Cast, type World } from "../support/world";

/**
 * S-03 database rules through the portal's own login (migration 0021): the portal reaches the ops
 * and tax schemas only through admin.*; makers propose, a different checker decides with a fresh
 * step-up and the digest of what they saw; rate changes and FBR exports need two different tax
 * officers; reads carry no CNIC or name; the audit chains verify.
 */
let w: World;
let c: Cast;
let tax2: Actor;
let ow: OperationsWorld;
let counter = Date.now();
type R = { ok: boolean; id?: number; status?: string; error?: string; expiresAt?: string };

beforeAll(async () => {
  w = await createWorld();
  c = await cast(w);
  tax2 = await invite(w, c.admin, c.admin2, "tax.two", "tax_officer");
  const a = await investor(w.su);
  const b = await investor(w.su);
  ow = await operationsWorld(w.su, [
    { wallet: a.wallet, units: 600n },
    { wallet: b.wallet, units: 399n },
    { wallet: `0x${randomBytes(20).toString("hex")}`, units: 1n },
  ]);
});
afterAll(async () => {
  await w.drop();
});

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

async function stepUp(a: Actor, stale = false): Promise<void> {
  await w.portal.query("SELECT admin.record_step_up($1, $2, $3)", [a.sessionHash, a.credentialId, ++counter]);
  if (stale) {
    await w.su.query("ALTER TABLE admin.sessions DISABLE TRIGGER sessions_guard");
    await w.su.query("UPDATE admin.sessions SET step_up_at = step_up_at - interval '5 minutes 1 second' WHERE token_hash = $1", [a.sessionHash]);
    await w.su.query("ALTER TABLE admin.sessions ENABLE TRIGGER sessions_guard");
  }
}

async function call(sql: string, params: unknown[]): Promise<R> {
  const { rows } = await w.portal.query<{ r: R }>(sql, params);
  const r = rows[0]?.r;
  if (!r) throw new Error("no result");
  return r;
}

async function read<T>(fn: string, a: Actor, ...args: unknown[]): Promise<T> {
  const params = [a.sessionHash, ...args];
  const { rows } = await w.portal.query<{ v: T }>(`SELECT admin.${fn}(${params.map((_, i) => `$${String(i + 1)}`).join(", ")}) AS v`, params);
  return rows[0]?.v as T;
}

describe("charges: maker proposes, a different checker decides (OT-2)", () => {
  it("proposed in the portal by a maker, approved by a checker with a fresh step-up and the digest", async () => {
    const evidence = createHash("sha256").update("invoice 4711").digest("hex");
    const p = await call("SELECT admin.propose_charge($1, $2, '2026-10', 'fee', 'platform', 'platform', 'platform fee October', 230000, $3) AS r", [c.ops_maker.sessionHash, ow.token, evidence]);
    expect(p.ok, p.error).toBe(true);
    const id = String(p.id);
    const view = await read<{ digest: string; proposedBy: string; evidence: string; blockers: { approve: string[] } }>("operations_charge", c.ops_checker, id);
    expect(view).toMatchObject({ proposedBy: c.ops_maker.handle, evidence, blockers: { approve: [] } });
    const asMaker = await read<{ blockers: { approve: string[] } }>("operations_charge", c.ops_maker, id);
    expect(asMaker.blockers.approve.join(" ")).toMatch(/operations checker/);
    // The maker cannot decide at all (no permission); a stale step-up and a wrong digest are refused.
    expect(await code(w.portal.query("SELECT admin.decide_charge($1, $2, 'approve', 'fee matches the schedule', $3)", [c.ops_maker.sessionHash, id, Buffer.from(view.digest, "hex")]))).toBe("42501");
    await stepUp(c.ops_checker, true);
    expect(await code(w.portal.query("SELECT admin.decide_charge($1, $2, 'approve', 'fee matches the schedule', $3)", [c.ops_checker.sessionHash, id, Buffer.from(view.digest, "hex")]))).toBe("PTS01");
    await stepUp(c.ops_checker);
    const wrong = await call("SELECT admin.decide_charge($1, $2, 'approve', 'fee matches the schedule', $3) AS r", [c.ops_checker.sessionHash, id, randomBytes(32)]);
    expect(wrong.error).toMatch(/differs from what you reviewed/);
    // Pool: the period of this fee (2026-10) has no rent yet, so the ledger refuses the overdraft.
    const ok = await call("SELECT admin.decide_charge($1, $2, 'reject', 'no rent collected for October yet', $3) AS r", [c.ops_checker.sessionHash, id, Buffer.from(view.digest, "hex")]);
    expect(ok).toMatchObject({ ok: true, status: "rejected" });
    const again = await call("SELECT admin.decide_charge($1, $2, 'approve', 'fee matches the schedule', $3) AS r", [c.ops_checker.sessionHash, id, Buffer.from(view.digest, "hex")]);
    expect(again.ok).toBe(false);
  });

  it("a charge approved by the checker posts its journal under the checker's handle", async () => {
    const view = await read<{ digest: string; amount: string }>("operations_charge", c.ops_checker, ow.chargeId);
    await stepUp(c.ops_checker);
    const r = await call("SELECT admin.decide_charge($1, $2, 'approve', 'invoice checked against the budget', $3) AS r", [c.ops_checker.sessionHash, ow.chargeId, Buffer.from(view.digest, "hex")]);
    expect(r).toMatchObject({ ok: true, status: "approved" });
    const j = await w.su.query<{ created_by: string; external_ref: string }>("SELECT created_by, external_ref FROM ledger.journal WHERE idempotency_key = $1", [
      `expense:${ow.token}:${ow.chargeId}:approved`,
    ]);
    expect(j.rows[0]).toEqual({ created_by: c.ops_checker.handle, external_ref: createHash("sha256").update(`invoice-${ow.token}`).digest("hex") });
  });

  it("the operating statement and periods are readable by operations, the trustee, tax officers and auditors", async () => {
    const st = await read<{ totals: { collected: string; distributableGross: string }; locked: boolean }>("operations_statement", c.trustee_officer, ow.token, ow.period);
    expect(st).toMatchObject({ totals: { collected: "10000000", distributableGross: "10000000" }, locked: true });
    const periods = await read<{ period: string }[]>("operations_periods", c.auditor);
    expect(periods.map((p) => p.period)).toContain("2026-09");
  });
});

describe("distribution approval by the checker (OT-6)", () => {
  it("cannot be approved before its statement is attached; returning it unlocks the period", async () => {
    const d = await read<{ digest: string; blockers: { approve: string[] }; lines: { subject: string | null; wallet: string }[] }>("operations_distribution", c.ops_checker, ow.distributionId);
    expect(d.blockers.approve.join(" ")).toMatch(/not attached/);
    // Wallets and the digest are random hex and can hold 13 decimal digits in a row: strip hex first.
    expect(JSON.stringify(d).replace(/0x[0-9a-fA-F]+|[0-9a-fA-F]{32,}/g, "")).not.toMatch(/\d{13}|name_enc|cnic/i);
    expect(d.lines.filter((l) => l.subject !== null).every((l) => /^[0-9a-f]{8}$/.test(l.subject ?? ""))).toBe(true);
    await stepUp(c.ops_checker);
    const refused = await call("SELECT admin.decide_distribution($1, $2, 'approve', 'recomputed from chain and statement', $3) AS r", [c.ops_checker.sessionHash, ow.distributionId, Buffer.from(d.digest, "hex")]);
    expect(refused.error).toMatch(/attached/);
    const back = await call("SELECT admin.decide_distribution($1, $2, 'reject', 'record date to be announced first', $3) AS r", [c.ops_checker.sessionHash, ow.distributionId, Buffer.from(d.digest, "hex")]);
    expect(back).toMatchObject({ ok: true, status: "returned" });
    expect((await read<{ locked: boolean }>("operations_statement", c.ops_maker, ow.token, ow.period)).locked).toBe(false);
  });
});

describe("tax rates and filing exports: two different tax officers (OT-7, OT-9)", () => {
  it("a rate version proposed by one tax officer is approved only by another", async () => {
    await stepUp(c.tax_officer);
    const tomorrow = (await w.su.query<{ d: string }>("SELECT (ops.pkt_today() + 1)::text AS d")).rows[0]?.d;
    const p = await call("SELECT admin.propose_tax_rate($1, 'reit_dividend', 'non_filer', 300000, $2::date, 'Income Tax Ordinance s.150, Finance Act 2026 (test)') AS r", [c.tax_officer.sessionHash, tomorrow]);
    expect(p.ok, p.error).toBe(true);
    const rates = (await read<{ rates: { id: number; digest: string; blockers: string[]; placeholder: boolean; inForce: boolean }[] }>("tax_overview", c.tax_officer)).rates;
    const mine = rates.find((r) => r.id === p.id);
    expect(mine?.blockers.join(" ")).toMatch(/You proposed it/);
    expect(rates.filter((r) => r.inForce).every((r) => r.placeholder)).toBe(true);
    const self = await call("SELECT admin.decide_tax_rate($1, $2, 'approve', 'basis checked against the gazette', $3) AS r", [c.tax_officer.sessionHash, p.id, Buffer.from(mine?.digest ?? "", "hex")]);
    expect(self.error).toMatch(/maker-checker/);
    await stepUp(tax2);
    const ok = await call("SELECT admin.decide_tax_rate($1, $2, 'approve', 'basis checked against the gazette', $3) AS r", [tax2.sessionHash, p.id, Buffer.from(mine?.digest ?? "", "hex")]);
    expect(ok).toMatchObject({ ok: true, status: "active" });
    // A retroactive rate is refused.
    const past = await call("SELECT admin.propose_tax_rate($1, 'spv_dividend', 'exempt', 0, '2020-01-01', 'retroactive change attempt (test)') AS r", [c.tax_officer.sessionHash]);
    expect(past.error).toMatch(/today or later/);
  });

  it("an export is requested by one tax officer, approved by another, and only they get a ticket", async () => {
    await stepUp(c.tax_officer);
    const req = await call("SELECT admin.request_tax_export($1, $2, '2026-09', '2026-09', 'monthly withholding statement (test)') AS r", [c.tax_officer.sessionHash, ow.token]);
    expect(req.ok, req.error).toBe(true);
    const view = await read<{ digest: string; blockers: { approve: string[]; generate: string[] } }>("tax_export", c.tax_officer, String(req.id));
    expect(view.blockers.approve.join(" ")).toMatch(/You requested it/);
    expect(await code(w.portal.query("SELECT admin.decide_tax_export($1, $2, 'approve', 'scope and purpose checked', $3)", [c.auditor.sessionHash, req.id, Buffer.from(view.digest, "hex")]))).toBe("42501");
    await stepUp(tax2);
    const ok = await call("SELECT admin.decide_tax_export($1, $2, 'approve', 'scope and purpose checked', $3) AS r", [tax2.sessionHash, req.id, Buffer.from(view.digest, "hex")]);
    expect(ok).toMatchObject({ ok: true, status: "approved" });
    // The CLI-requested export of the fixtures: neither of its officers is in the portal, so no officer may generate it.
    await stepUp(c.tax_officer);
    const foreign = await call("SELECT admin.issue_tax_export_ticket($1, $2, $3) AS r", [c.tax_officer.sessionHash, ow.exportId, randomBytes(32)]);
    expect(foreign.ok).toBe(false);
    const t = await call("SELECT admin.issue_tax_export_ticket($1, $2, $3) AS r", [c.tax_officer.sessionHash, req.id, createHash("sha256").update(randomBytes(32)).digest()]);
    expect(t.ok, t.error).toBe(true);
    expect(t.expiresAt).toMatch(/Z$/);
    // The portal role itself can never redeem a ticket or read a sealed CNIC.
    expect(await code(w.portal.query("SELECT * FROM tax.redeem_export_ticket($1, $2)", [randomBytes(32), req.id]))).toBe("42501");
    expect(await code(w.portal.query("SELECT sealed FROM tax.sealed_cnics"))).toBe("42501");
  });

  it("the admin and operations audit chains verify", async () => {
    expect(await verify(w)).toEqual([]);
    expect((await w.su.query("SELECT * FROM ops.verify_audit()")).rows).toEqual([]);
  });
});
