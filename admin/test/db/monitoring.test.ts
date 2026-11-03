import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cast, createWorld, invite, type Actor, type Cast, type World } from "../support/world";

/**
 * Transaction monitoring (migration 0051 TM-1..TM-6): rules open alerts in the same transaction as
 * the money movement, never twice for one pattern; an alert becomes an STR case (one officer) or is
 * dismissed (two officers); thresholds and declared income are compliance decisions with a step-up.
 */
let w: World;
let c: Cast;
let comp2: Actor;
let counter = Date.now() + 7_000_000;
type R = { ok: boolean; status?: string; error?: string; strCase?: number | null; opened?: number };
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

beforeAll(async () => {
  w = await createWorld();
  c = await cast(w);
  comp2 = await invite(w, c.admin, c.admin2, "compliance.two", "compliance_officer");
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

async function one<T>(sql: string, params: unknown[]): Promise<T> {
  const { rows } = await w.portal.query<{ r: T }>(sql, params);
  return rows[0]?.r as T;
}

async function stepUp(a: Actor): Promise<void> {
  await w.portal.query("SELECT admin.record_step_up($1, $2, $3)", [a.sessionHash, a.credentialId, ++counter]);
}

async function investor(): Promise<string> {
  const { rows } = await w.su.query<{ id: string }>(
    "INSERT INTO kyc.subjects (name_hash, name_enc, pepper_version, cnic_last4, created_by) VALUES ($1, $2, 1, '4321', 'test') RETURNING id",
    [randomBytes(32), randomBytes(48)],
  );
  return rows[0]?.id ?? "";
}

const part = () => Array.from(randomBytes(4), (b) => CROCKFORD.charAt(b % 32)).join("");

/** A matched subscription credit as bank.book_credit leaves it (journal, intent, credit). Returns the Raast reference. */
async function credit(subject: string, amountPaisa: number): Promise<string> {
  const ref = `RAAST-TM-${randomBytes(4).toString("hex").toUpperCase()}`;
  const intent = `PT-${part()}-${part()}`;
  await w.su.query(
    "INSERT INTO bank.payment_intents (code, purpose, subject_id, amount_paisa, ledger_key, credit_account, expires_at, created_by) VALUES ($1, 'subscription', $2, $3, $4, 'bank:suspense', now() + interval '1 day', 'test')",
    [intent, subject, amountPaisa, `sub:0x${randomBytes(32).toString("hex")}:paid`],
  );
  await w.su.query("INSERT INTO bank.events (event_id, type, body_sha256, key_id) VALUES ($1, 'credit.received', $2, 'k1')", [`evt-${ref}`, randomBytes(32)]);
  const j = await w.su.query<{ id: string }>("SELECT ledger.post_journal($1, 'payment_in', 'tm test', $2, 'bank-webhook', $3::jsonb) AS id", [
    `test:tm:${ref}`,
    ref,
    JSON.stringify([
      { account: "bank:trustee-escrow", amount: String(amountPaisa) },
      { account: "bank:suspense", amount: String(-amountPaisa) },
    ]),
  ]);
  await w.su.query(
    "INSERT INTO bank.credits (raast_ref, event_id, amount_paisa, value_date, payer_hash, payer_last4, intent_code, status, reason, journal_id) VALUES ($1, $2, $3, current_date, $4, '1111', $5, 'matched', 'matched for the test', $6)",
    [ref, `evt-${ref}`, amountPaisa, randomBytes(32), intent, j.rows[0]?.id],
  );
  return ref;
}

async function refund(ref: string, amountPaisa: number): Promise<void> {
  const j = await w.su.query<{ id: string }>("SELECT ledger.post_journal($1, 'payment_in', 'tm test refund', $2, 'offering', $3::jsonb) AS id", [
    `test:tm:${ref}:refund`,
    ref,
    JSON.stringify([
      { account: "bank:suspense", amount: String(amountPaisa) },
      { account: "bank:trustee-escrow", amount: String(-amountPaisa) },
    ]),
  ]);
  await w.su.query("INSERT INTO bank.credit_refunds (raast_ref, ledger_key, journal_id, refunded_by, reason) VALUES ($1, $2, $3, 'offering', 'investor withdrew in the window')", [
    ref,
    `sub:0x${randomBytes(32).toString("hex")}:refunded`,
    j.rows[0]?.id,
  ]);
}

async function alerts(subject: string): Promise<{ id: string; rule: string; status: string; opened_by: string; evidence: unknown[] }[]> {
  return (
    await w.su.query<{ id: string; rule: string; status: string; opened_by: string; evidence: unknown[] }>(
      "SELECT id, rule, status, opened_by, evidence FROM compliance.tm_alerts WHERE subject_id = $1 ORDER BY id",
      [subject],
    )
  ).rows;
}

async function digest(id: string): Promise<Buffer> {
  const a = await one<{ digest: string }>("SELECT admin.tm_alert($1, $2) AS r", [c.compliance_officer.sessionHash, id]);
  return Buffer.from(a.digest, "hex");
}

async function act(o: Actor, id: string, action: string, reason: string, seen?: Buffer): Promise<R> {
  return one<R>("SELECT admin.tm_alert_act($1, $2, $3, $4, $5) AS r", [o.sessionHash, id, action, reason, seen ?? (await digest(id))]);
}

describe("transaction monitoring (migration 0051)", () => {
  it("structuring: three payments just below the threshold open one alert, with the payment, never twice", async () => {
    const s = await investor();
    await credit(s, 190_000_000);
    await credit(s, 185_000_000);
    expect(await alerts(s)).toEqual([]);
    await credit(s, 199_000_000);
    let found = await alerts(s);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ rule: "structuring", status: "open", opened_by: "monitor:bank.credits" });
    expect(found[0]?.evidence).toHaveLength(3);
    // The pattern goes on: no second alert for an overlapping window. A payment above the threshold does not count.
    await credit(s, 195_000_000);
    await credit(s, 250_000_000);
    found = await alerts(s);
    expect(found).toHaveLength(1);
    expect(JSON.stringify(found)).not.toMatch(/4321|name/);
  });

  it("only compliance officers and auditors see alerts; what was detected never changes", async () => {
    const desk = await one<{ open: { rule: string }[]; rules: { code: string; placeholder: boolean }[] }>("SELECT admin.tm_desk($1) AS r", [c.auditor.sessionHash]);
    expect(desk.open.map((a) => a.rule)).toContain("structuring");
    expect(desk.rules.map((r) => r.code)).toEqual(["income_band", "payout_account_changes", "rapid_in_out", "structuring"]);
    expect(desk.rules.every((r) => r.placeholder)).toBe(true);
    expect(await code(one("SELECT admin.tm_desk($1) AS r", [c.ops_maker.sessionHash]))).toBe("42501");
    expect(await code(one("SELECT admin.tm_desk($1) AS r", [c.support_agent.sessionHash]))).toBe("42501");
    const id = (await w.su.query<{ id: string }>("SELECT id FROM compliance.tm_alerts ORDER BY id LIMIT 1")).rows[0]?.id;
    expect(await code(w.su.query("UPDATE compliance.tm_alerts SET summary = 'nothing to see here at all' WHERE id = $1", [id]))).toBe("23514");
    expect(await code(w.su.query("DELETE FROM compliance.tm_alerts WHERE id = $1", [id]))).toBe("42501");
    expect(await code(w.su.query("DELETE FROM compliance.tm_alert_events"))).toBe("42501");
  });

  it("dismissing needs two compliance officers; opening an STR case needs one", async () => {
    const first = (await w.su.query<{ id: string }>("SELECT id FROM compliance.tm_alerts WHERE rule = 'structuring' AND status = 'open' ORDER BY id LIMIT 1")).rows[0]?.id ?? "";
    const other = await investor();
    for (const amount of [190_000_000, 191_000_000, 192_000_000]) await credit(other, amount);
    const second = (await alerts(other))[0]?.id ?? "";

    // An operations officer may not act, even with a fresh step-up.
    await stepUp(c.ops_maker);
    expect(await code(act(c.ops_maker, first, "propose_dismiss", "regular salary payments"))).toBe("42501");

    await stepUp(c.compliance_officer);
    const stale = await act(c.compliance_officer, first, "propose_dismiss", "regular salary payments", randomBytes(32));
    expect(stale.ok).toBe(false);
    expect(stale.error).toMatch(/changed while you were reading/);
    expect(await act(c.compliance_officer, first, "propose_dismiss", "regular salary payments")).toEqual({ ok: true, status: "dismiss_proposed", strCase: null });
    const self = await act(c.compliance_officer, first, "confirm_dismiss", "agree, salary payments");
    expect(self.ok).toBe(false);
    expect(self.error).toMatch(/second officer/);
    await stepUp(comp2);
    expect(await act(comp2, first, "confirm_dismiss", "checked the payslips, agree")).toMatchObject({ ok: true, status: "dismissed" });
    expect((await act(comp2, first, "escalate", "changed my mind after all")).ok).toBe(false);

    // Escalating opens the STR case in the same transaction, with the rule's category, and links it.
    const esc = await act(comp2, second, "escalate", "no economic reason for the split");
    expect(esc).toMatchObject({ ok: true, status: "escalated" });
    const str = await w.su.query<{ category: string; opened_by: string; summary: string }>("SELECT category, opened_by, summary FROM compliance.str_cases WHERE id = $1", [esc.strCase]);
    expect(str.rows[0]).toMatchObject({ category: "structuring", opened_by: "compliance.two" });
    expect(str.rows[0]?.summary.startsWith(`Monitoring alert ${second} (structuring)`)).toBe(true);
    const events = await w.su.query<{ action: string; actor: string }>("SELECT action, actor FROM compliance.tm_alert_events WHERE alert_id = $1 ORDER BY id", [second]);
    expect(events.rows.map((e) => `${e.action}:${e.actor}`)).toEqual(["opened:monitor:bank.credits", "escalate:compliance.two"]);
  });

  it("rapid in and out: a payment refunded within the window opens an alert", async () => {
    const s = await investor();
    const ref = await credit(s, 50_000_000);
    expect(await alerts(s)).toEqual([]);
    await refund(ref, 50_000_000);
    expect((await alerts(s)).map((a) => `${a.rule}:${a.opened_by}`)).toEqual(["rapid_in_out:monitor:bank.credit_refunds"]);
  });

  it("income band: payments above the declared income open an alert when the income is recorded", async () => {
    const s = await investor();
    await credit(s, 80_000_000);
    await credit(s, 90_000_000);
    expect(await alerts(s)).toEqual([]);
    expect(await code(one("SELECT admin.tm_set_income($1, $2, 100000000, 'from the KYC form') AS r", [c.auditor.sessionHash, s]))).toBe("42501");
    await stepUp(c.compliance_officer);
    expect((await one<R>("SELECT admin.tm_set_income($1, $2, 0, 'from the KYC form') AS r", [c.compliance_officer.sessionHash, s])).ok).toBe(false);
    expect(await one<R>("SELECT admin.tm_set_income($1, $2, 100000000, 'from the KYC form') AS r", [c.compliance_officer.sessionHash, s])).toEqual({ ok: true, status: "saved", opened: 1 });
    expect((await alerts(s)).map((a) => a.rule)).toEqual(["income_band"]);
    const by = await w.su.query<{ recorded_by: string }>("SELECT recorded_by FROM compliance.tm_income WHERE subject_id = $1", [s]);
    expect(by.rows[0]?.recorded_by).toBe(c.compliance_officer.handle);
  });

  it("payout account changes: a third account within the window opens an alert", async () => {
    const s = await investor();
    const payee = (registeredHoursAgo: number, superseded: boolean) =>
      w.su.query(
        `INSERT INTO bank.payees (subject_id, iban_hash, iban_enc, iban_last4, bank_code, registered_at, active_from, registered_by, superseded_at)
         VALUES ($1, $2, $3, '7777', 'MEZN', now() - make_interval(hours => $4), now() - make_interval(hours => $4) + interval '72 hours', 'bank', CASE WHEN $5 THEN now() END)`,
        [s, randomBytes(32), randomBytes(60), registeredHoursAgo, superseded],
      );
    await payee(400, true);
    await payee(200, true);
    expect(await alerts(s)).toEqual([]);
    await payee(1, false);
    const found = await alerts(s);
    expect(found.map((a) => a.rule)).toEqual(["payout_account_changes"]);
    expect(JSON.stringify(found[0]?.evidence)).toMatch(/"last4":"7777"/);
  });

  it("thresholds: compliance officers change them within range; a sweep applies them to past payments", async () => {
    await stepUp(c.compliance_officer);
    const set = (o: Actor, params: string) => one<R>("SELECT admin.tm_rule_set($1, 'structuring', $2::jsonb, true, 'confirmed by the MLRO memo') AS r", [o.sessionHash, params]);
    const bad = await set(c.compliance_officer, JSON.stringify({ thresholdPaisa: 100_000_000, bandPercent: 150, minCount: 2, windowDays: 7 }));
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/whole number in its range/);
    expect((await set(c.compliance_officer, '{"thresholdPaisa": 100000000}')).ok).toBe(false);
    expect(await code(set(c.ops_checker, "{}"))).toBe("42501");

    // Two payments of Rs 900,000 in a week: below the placeholder rule, a hit under the confirmed one.
    const s = await investor();
    await credit(s, 90_000_000);
    await credit(s, 90_000_000);
    expect(await alerts(s)).toEqual([]);
    expect(await set(c.compliance_officer, JSON.stringify({ thresholdPaisa: 100_000_000, bandPercent: 80, minCount: 2, windowDays: 7 }))).toEqual({ ok: true, status: "saved" });
    expect((await one<R>("SELECT admin.tm_sweep($1) AS r", [c.compliance_officer.sessionHash])).ok).toBe(true);
    expect((await alerts(s)).map((a) => a.rule)).toEqual(["structuring"]);
    const rule = await w.su.query<{ placeholder: boolean; updated_by: string }>("SELECT placeholder, updated_by FROM compliance.tm_rules WHERE code = 'structuring'");
    expect(rule.rows[0]).toEqual({ placeholder: false, updated_by: c.compliance_officer.handle });
    expect(await code(w.su.query("UPDATE compliance.tm_rules SET updated_by = $1 WHERE code = 'income_band'", [c.compliance_officer.handle]))).toBe("42501");
  });

  it("every step is in the compliance audit chain, which still verifies", async () => {
    const actions = await w.su.query<{ action: string }>("SELECT DISTINCT action FROM compliance.audit WHERE action LIKE 'tm.%' ORDER BY action");
    for (const a of ["tm.confirm_dismiss", "tm.escalate", "tm.income_set", "tm.opened", "tm.propose_dismiss", "tm.rule_set", "tm.swept"]) {
      expect(actions.rows.map((r) => r.action)).toContain(a);
    }
    expect((await w.su.query("SELECT * FROM compliance.verify_audit()")).rows).toEqual([]);
  });
});
