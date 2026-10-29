import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { passRecon } from "../support/approvals";
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

describe("bank statement import from the portal (migration 0037 BI-1..BI-3)", () => {
  it("an operations maker imports with a fresh step-up; the same content is one statement; a different one for that day is refused", async () => {
    const account = `TEST-PORTAL-${randomBytes(3).toString("hex").toUpperCase()}`;
    const ledger = `bank:test-portal-${account.toLowerCase()}`;
    await w.su.query("SELECT ledger.open_account($1, 'asset', 'PKR')", [ledger]);
    await w.su.query("SELECT recon.register_bank_account($1, $2, 'test:setup')", [account, ledger]);
    const lines = [
      { valueDate: "2026-10-20", amountPaisa: "500000", reference: "RAAST-PORTAL-0001", counterparty: "Tenant (test)", balancePaisa: "500000" },
      { valueDate: "2026-10-20", amountPaisa: "-1000", reference: "BANKFEE-PORTAL-01", counterparty: "Bank charge", balancePaisa: "499000" },
    ];
    const imp = (a: Actor, closing: string, l: unknown[]) =>
      call("SELECT admin.import_bank_statement($1, $2, '2026-10-20'::date, 0, $3, $4::jsonb) AS r", [a.sessionHash, account, closing, JSON.stringify(l)]);
    await stepUp(c.ops_maker, true);
    expect(await code(imp(c.ops_maker, "499000", lines))).toBe("PTS01");
    await stepUp(c.ops_maker);
    const first = await imp(c.ops_maker, "499000", lines);
    expect(first).toMatchObject({ ok: true, status: "imported" });
    expect((await imp(c.ops_maker, "499000", lines)).id).toBe(first.id);
    const other = await imp(c.ops_maker, "500000", lines.slice(0, 1));
    expect(other.ok).toBe(false);
    const bad = await imp(c.ops_maker, "1", lines);
    expect(bad.ok).toBe(false);
    await stepUp(c.ops_checker);
    expect(await code(imp(c.ops_checker, "499000", lines))).toBe("42501");
    const st = await w.su.query<{ imported_by: string }>("SELECT imported_by FROM recon.bank_statements WHERE id = $1", [first.id]);
    expect(st.rows[0]?.imported_by).toBe(c.ops_maker.handle);
    const view = await read<{ accounts: string[]; statements: { id: number }[] }>("bank_statements", c.auditor);
    expect(view.accounts).toContain(account);
    expect(view.statements.map((s) => s.id)).toContain(first.id);
  });
});

describe("bank desk: suspense returns and held payouts (migration 0038 BD-1..BD-3)", () => {
  it("a suspense credit goes back to its payer only after a maker asks and a different checker approves", async () => {
    await passRecon(w.su);
    const ref = `RAAST-SUSP-${randomBytes(4).toString("hex").toUpperCase()}`;
    await w.su.query("INSERT INTO bank.events (event_id, type, body_sha256, key_id) VALUES ($1, 'credit.received', $2, 'k1')", [`evt-${ref}`, randomBytes(32)]);
    await w.su.query("SELECT bank.book_credit($1, $2::jsonb, 'bank-webhook')", [
      `evt-${ref}`,
      JSON.stringify({ raastRef: ref, amountPaisa: "4200", valueDate: "2026-10-20", payerHash: randomBytes(32).toString("hex"), payerLast4: "9876", intentCode: null }),
    ]);
    let desk = await read<{ suspense: { ref: string; payerLast4: string }[] }>("bank_desk", c.auditor);
    expect(desk.suspense.find((s) => s.ref === ref)).toMatchObject({ payerLast4: "9876" });
    await stepUp(c.ops_maker);
    expect((await call("SELECT admin.request_suspense_return($1, 'RAAST-NOT-THERE', 'payer could not be identified') AS r", [c.ops_maker.sessionHash])).ok).toBe(false);
    const ask = await call("SELECT admin.request_suspense_return($1, $2, 'payer could not be identified') AS r", [c.ops_maker.sessionHash, ref]);
    expect(ask).toMatchObject({ ok: true, status: "open" });
    expect((await call("SELECT admin.request_suspense_return($1, $2, 'payer could not be identified') AS r", [c.ops_maker.sessionHash, ref])).error).toMatch(/already waiting/);
    await stepUp(c.ops_checker);
    expect(await code(call("SELECT admin.request_suspense_return($1, $2, 'checkers do not ask') AS r", [c.ops_checker.sessionHash, ref]))).toBe("42501");
    const done = await call("SELECT admin.decide_suspense_return($1, $2, 'approve', 'no matching intent; returned to sender') AS r", [c.ops_checker.sessionHash, ask.id]);
    expect(done).toMatchObject({ ok: true, status: "returned" });
    const ret = await w.su.query<{ returned_by: string }>("SELECT returned_by FROM bank.credit_returns WHERE raast_ref = $1", [ref]);
    expect(ret.rows[0]?.returned_by).toBe(c.ops_checker.handle);
    desk = await read("bank_desk", c.auditor);
    expect(desk.suspense.some((s) => s.ref === ref)).toBe(false);
    expect(await code(w.su.query("UPDATE admin.suspense_returns SET reason = 'changed afterwards!' WHERE id = $1", [ask.id]))).toBe("42501");
  });

  it("a follow-up batch is refused while no held line can be paid", async () => {
    await stepUp(c.ops_maker);
    const r = await call("SELECT admin.create_followup_batch($1, 999999) AS r", [c.ops_maker.sessionHash]);
    expect(r.error).toMatch(/no held line/);
    expect(Array.isArray((await read<{ held: unknown[] }>("bank_desk", c.ops_maker)).held)).toBe(true);
  });
});

describe("signing policy changes from the portal (migration 0039 SP-1..SP-5)", () => {
  it("a maker proposes new values for an existing kind, a different checker activates it; the shape cannot change", async () => {
    const kind = `test.portal${randomBytes(3).toString("hex")}`;
    const p0 = await w.su.query<{ id: string }>("SELECT signer.propose_policy($1, $2::jsonb, 'cli:maker') AS id", [kind, JSON.stringify({ chainId: 586586, maxPerDay: "100", approvals: 2 })]);
    await w.su.query("SELECT signer.approve_policy($1, 'cli:checker')", [p0.rows[0]?.id]);
    const propose = (a: Actor, rule: object) => call("SELECT admin.propose_signer_policy($1, $2, $3::jsonb) AS r", [a.sessionHash, kind, JSON.stringify(rule)]);
    await stepUp(c.ops_maker);
    expect((await call("SELECT admin.propose_signer_policy($1, 'no.such.kind', '{}'::jsonb) AS r", [c.ops_maker.sessionHash])).error).toMatch(/existing kind/);
    expect((await propose(c.ops_maker, { chainId: 586586, maxPerDay: "100", approvals: 2, keyRef: "rogue" })).error).toMatch(/exactly the fields/);
    expect((await propose(c.ops_maker, { chainId: 586586, maxPerDay: "100", approvals: 2 })).error).toMatch(/same as the active/);
    const p = await propose(c.ops_maker, { chainId: 586586, maxPerDay: "250", approvals: 2 });
    expect(p).toMatchObject({ ok: true, status: "proposed" });
    expect((await propose(c.ops_maker, { chainId: 586586, maxPerDay: "300", approvals: 2 })).error).toMatch(/already waiting/);
    const listed = await read<{ kind: string; proposals: { id: number }[] }[]>("signer_policies", c.auditor);
    expect(listed.find((k) => k.kind === kind)?.proposals.map((x) => x.id)).toEqual([p.id]);
    expect(await code(call("SELECT admin.approve_signer_policy($1, $2) AS r", [c.ops_maker.sessionHash, p.id]))).toBe("42501");
    await stepUp(c.ops_checker);
    expect(await call("SELECT admin.approve_signer_policy($1, $2) AS r", [c.ops_checker.sessionHash, p.id])).toMatchObject({ ok: true, status: "active" });
    const active = await w.su.query<{ rule: { maxPerDay: string }; approved_by: string }>(
      "SELECT rule, approved_by FROM signer.policies WHERE kind = $1 AND approved_at IS NOT NULL AND retired_at IS NULL", [kind]);
    expect(active.rows[0]).toMatchObject({ rule: { maxPerDay: "250" }, approved_by: c.ops_checker.handle });
    // A proposal can be withdrawn; it stays in the history, retired unapproved.
    await stepUp(c.ops_maker);
    const q = await propose(c.ops_maker, { chainId: 586586, maxPerDay: "1", approvals: 0 });
    expect(await call("SELECT admin.withdraw_signer_policy($1, $2) AS r", [c.ops_maker.sessionHash, q.id])).toMatchObject({ ok: true, status: "withdrawn" });
    expect((await w.su.query("SELECT * FROM signer.verify_audit()")).rows).toEqual([]);
  });
});

describe("document vault uploads from the portal (migration 0042 PV-1, PV-2)", () => {
  it("an operations maker with a fresh step-up may store; the upload is audited; the list shows what is published", async () => {
    const sha = createHash("sha256").update(`vault-test-${randomBytes(4).toString("hex")}`).digest();
    await stepUp(c.ops_maker, true);
    expect(await code(call("SELECT admin.vault_upload($1, $2, 1024, 'application/pdf') AS r", [c.ops_maker.sessionHash, sha]))).toBe("PTS01");
    await stepUp(c.ops_maker);
    expect((await call("SELECT admin.vault_upload($1, $2, 1024, 'text/html') AS r", [c.ops_maker.sessionHash, sha])).ok).toBe(false);
    const ok = (await w.portal.query<{ r: { ok: boolean; officer: string } }>("SELECT admin.vault_upload($1, $2, 1024, 'application/pdf') AS r", [c.ops_maker.sessionHash, sha])).rows[0]?.r;
    expect(ok).toEqual({ ok: true, officer: c.ops_maker.handle });
    const a = await w.su.query("SELECT 1 FROM admin.audit WHERE action = 'vault.upload' AND detail->>'sha256' = $1", [sha.toString("hex")]);
    expect(a.rowCount).toBe(1);
    await stepUp(c.ops_checker);
    expect(await code(call("SELECT admin.vault_upload($1, $2, 1024, 'application/pdf') AS r", [c.ops_checker.sessionHash, sha]))).toBe("42501");
    await w.su.query(
      "INSERT INTO vault.objects (sha256, size_bytes, media_type, key_version, wrapped_key, nonce, created_by) VALUES ($1, 1024, 'application/pdf', 1, $2, $3, $4)",
      [sha, randomBytes(60), randomBytes(12), `officer:${c.ops_maker.handle}`],
    );
    const list = await read<{ sha256: string; published: boolean; by: string }[]>("vault_objects", c.auditor);
    expect(list.find((o) => o.sha256 === sha.toString("hex"))).toMatchObject({ published: false, by: `officer:${c.ops_maker.handle}` });
  });
});

describe("tenant rent invoices and payment links (migration 0044 RI-1..RI-4)", () => {
  it("a maker issues an invoice with a one-time link; payment is recorded maker-checker; the tenant page shows only what it needs", async () => {
    const account = `TEST-RENT-${randomBytes(3).toString("hex").toUpperCase()}`;
    await w.su.query("SELECT ledger.open_account($1, 'asset', 'PKR')", [`bank:${account.toLowerCase()}`]);
    await w.su.query("SELECT recon.register_bank_account($1, $2, 'test:setup')", [account, `bank:${account.toLowerCase()}`]);
    const today = (await w.su.query<{ d: string }>("SELECT current_date::text AS d")).rows[0]?.d ?? "";
    const st = await w.su.query<{ id: string }>("SELECT recon.import_bank_statement('test:import', $1, $2::date, 0, 7500000, $3::jsonb) AS id", [
      account,
      today,
      JSON.stringify([{ valueDate: today, amountPaisa: "7500000", reference: `RAAST-TENANT-${randomBytes(3).toString("hex").toUpperCase()}`, counterparty: "Tenant shop 4", balancePaisa: "7500000" }]),
    ]);
    await stepUp(c.ops_maker);
    const inv = (await w.portal.query<{ r: { ok: boolean; id: number; code: string; link: string } }>(
      "SELECT admin.create_rent_invoice($1, $2, '2026-10', 'Shop 4, ground floor', 7500000, current_date + 10) AS r", [c.ops_maker.sessionHash, ow.token])).rows[0]?.r;
    expect(inv).toMatchObject({ ok: true });
    expect(inv?.code).toMatch(/^TR-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect((await call("SELECT admin.create_rent_invoice($1, $2, '2026-10', 'Tenant 3520212345678', 100, current_date) AS r", [c.ops_maker.sessionHash, ow.token])).ok).toBe(false);

    // The tenant's page: by link only, nothing else.
    const page = (await w.su.query<{ v: Record<string, string> | null }>("SELECT ops.web_invoice($1) AS v", [inv?.link])).rows[0]?.v;
    expect(page).toMatchObject({ code: inv?.code, amountPaisa: "7500000", status: "open", tenant: "Shop 4, ground floor" });
    expect((await w.su.query<{ v: unknown }>("SELECT ops.web_invoice($1) AS v", [randomBytes(32).toString("base64url")])).rows[0]?.v).toBeNull();
    const stored = await w.su.query<{ link_hash: Buffer }>("SELECT link_hash FROM ops.rent_invoices WHERE id = $1", [inv?.id]);
    expect(stored.rows[0]?.link_hash.toString("hex")).toBe(createHash("sha256").update(inv?.link ?? "").digest("hex"));

    const list = await read<{ invoices: { id: number; candidates: { statement: number; line: number }[] }[] }>("rent_invoices", c.ops_maker);
    const cand = list.invoices.find((x) => x.id === inv?.id)?.candidates.find((x) => String(x.statement) === st.rows[0]?.id);
    expect(cand).toBeDefined();
    const rec = await call("SELECT admin.record_invoice_payment($1, $2, $3, $4) AS r", [c.ops_maker.sessionHash, inv?.id, cand?.statement, cand?.line]);
    expect(rec).toMatchObject({ ok: true, status: "proposed" });
    await stepUp(c.ops_checker);
    expect(await call("SELECT admin.decide_collection($1, $2, 'approve', 'matches the tenant invoice and the bank line') AS r", [c.ops_checker.sessionHash, rec.id])).toMatchObject({
      ok: true,
      status: "approved",
    });
    expect((await w.su.query<{ v: { status: string } }>("SELECT ops.web_invoice($1) AS v", [inv?.link])).rows[0]?.v.status).toBe("paid");
    expect(await code(w.su.query("UPDATE ops.rent_invoices SET amount_paisa = 1 WHERE id = $1", [inv?.id]))).toBe("42501");
    expect((await call("SELECT admin.cancel_rent_invoice($1, $2) AS r", [c.ops_maker.sessionHash, inv?.id])).ok).toBe(false);
  });
});
