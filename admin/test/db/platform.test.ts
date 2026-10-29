import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { passRecon } from "../support/approvals";
import { cast, createWorld, type Actor, type Cast, type World } from "../support/world";

/**
 * Platform roles (migration 0031): the platform owner's emergency payout hold (PR-2) and the
 * support lookup (PR-4), against the real database functions.
 */
let w: World;
let c: Cast;
let counter = Date.now();

beforeAll(async () => {
  w = await createWorld();
  c = await cast(w);
});
afterAll(async () => {
  await w.drop();
});

type Answer = { ok: boolean; error?: string; event?: number; id?: number; status?: string };

async function stepUp(a: Actor): Promise<void> {
  await w.portal.query("SELECT admin.record_step_up($1, $2, $3)", [a.sessionHash, a.credentialId, ++counter]);
}

async function hold(a: Actor, reason = "bank reported a suspicious payout file"): Promise<Answer> {
  await stepUp(a);
  return (await w.portal.query<{ r: Answer }>("SELECT admin.emergency_payout_hold($1, $2) AS r", [a.sessionHash, reason])).rows[0]?.r ?? { ok: false };
}

async function allowed(): Promise<boolean> {
  return (await w.su.query<{ v: boolean }>("SELECT recon.payouts_allowed() AS v")).rows[0]?.v ?? false;
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return (e as { code?: string }).code ?? "?";
  }
}

describe("emergency payout hold (PR-2)", () => {
  it("is refused before any reconciliation run (payouts are blocked anyway)", async () => {
    const r = await hold(c.platform_owner);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no reconciliation run exists yet/);
  });

  it("needs a fresh step-up and a reason", async () => {
    await passRecon(w.su);
    await w.su.query("ALTER TABLE admin.sessions DISABLE TRIGGER sessions_guard");
    await stepUp(c.platform_owner);
    await w.su.query("UPDATE admin.sessions SET step_up_at = step_up_at - interval '5 minutes 1 second' WHERE token_hash = $1", [c.platform_owner.sessionHash]);
    await w.su.query("ALTER TABLE admin.sessions ENABLE TRIGGER sessions_guard");
    expect(await code(w.portal.query("SELECT admin.emergency_payout_hold($1, 'bank reported a suspicious payout file')", [c.platform_owner.sessionHash]))).toBe("PTS01");
    await stepUp(c.platform_owner);
    expect(await code(w.portal.query("SELECT admin.emergency_payout_hold($1, 'short')", [c.platform_owner.sessionHash]))).toBe("23514");
    expect(await allowed()).toBe(true);
  });

  it("stops payouts at once, audited in both chains, and a second hold is refused", async () => {
    const r = await hold(c.platform_owner);
    expect(r.ok).toBe(true);
    expect(await allowed()).toBe(false);
    const e = await w.su.query<{ action: string; actor: string; reason: string }>("SELECT action, actor, reason FROM recon.gate_events WHERE id = $1", [r.event]);
    expect(e.rows[0]).toMatchObject({ action: "freeze", actor: c.platform_owner.handle });
    expect(e.rows[0]?.reason).toMatch(/^emergency hold by /);
    const recon = await w.su.query("SELECT 1 FROM recon.audit WHERE action = 'gate.hold' AND (detail->>'event')::bigint = $1", [r.event]);
    expect(recon.rowCount).toBe(1);
    const admin = await w.su.query("SELECT 1 FROM admin.audit WHERE action = 'payouts.held' AND (detail->>'event')::bigint = $1", [r.event]);
    expect(admin.rowCount).toBe(1);
    const again = await hold(c.platform_owner);
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/already frozen/);
  });

  it("only the platform owner may hold; the platform owner cannot release", async () => {
    for (const a of [c.ops_maker, c.ops_checker, c.admin, c.auditor, c.support_agent, c.property_manager]) {
      await stepUp(a);
      expect(await code(w.portal.query("SELECT admin.emergency_payout_hold($1, 'not my permission to use')", [a.sessionHash]))).toBe("42501");
    }
    expect(await code(w.portal.query("SELECT admin.request_unfreeze($1, 'the owner tries to lift it')", [c.platform_owner.sessionHash]))).toBe("42501");
  });

  it("is lifted maker-checker, and only after a reconciliation run that started after the hold has passed", async () => {
    const ask = (await w.portal.query<{ r: Answer }>("SELECT admin.request_unfreeze($1, 'bank confirmed the payout file is genuine') AS r", [c.ops_maker.sessionHash])).rows[0]?.r;
    expect(ask?.ok).toBe(true);
    const freezeEvent = (await w.su.query<{ id: string }>("SELECT freeze_event AS id FROM recon.unfreeze_requests WHERE id = $1", [ask?.id])).rows[0]?.id;
    const decide = async () => {
      await stepUp(c.ops_checker);
      return (
        await w.portal.query<{ r: Answer }>("SELECT admin.decide_unfreeze($1, $2, 'approve', 'checked with the bank myself', $3) AS r", [
          c.ops_checker.sessionHash,
          ask?.id,
          freezeEvent,
        ])
      ).rows[0]?.r;
    };
    const early = await decide();
    expect(early?.ok).toBe(false);
    expect(early?.error).toMatch(/passed after run/);
    await passRecon(w.su);
    expect((await decide())?.status).toBe("approved");
    expect(await allowed()).toBe(true);
  });
});

describe("support lookup (PR-4)", () => {
  async function subject(): Promise<{ id: string; ref: string }> {
    const { rows } = await w.su.query<{ id: string }>(
      "INSERT INTO kyc.subjects (name_hash, name_enc, pepper_version, cnic_last4, created_by) VALUES ($1, $2, 1, '4321', 'test') RETURNING id",
      [randomBytes(32), randomBytes(64)],
    );
    const id = rows[0]?.id ?? "";
    return { id, ref: id.replace(/-/g, "").slice(0, 8) };
  }
  const lookup = async (a: Actor, ref: string) =>
    (await w.portal.query<{ v: Record<string, unknown> }>("SELECT admin.support_lookup($1, $2) AS v", [a.sessionHash, ref])).rows[0]?.v ?? {};

  it("finds one investor by reference with a masked CNIC and no personal data, and audits the lookup", async () => {
    const s = await subject();
    const v = await lookup(c.support_agent, s.ref.toUpperCase());
    expect(v).toMatchObject({ ok: true, found: true, investor: { ref: s.ref, cnic: "*****-****432-1", status: "pending", notices: [] } });
    expect(JSON.stringify(v)).not.toMatch(/name|hold|reason|case|4321/i);
    const audit = await w.su.query("SELECT 1 FROM admin.audit WHERE action = 'support.lookup' AND detail->>'ref' = $1 AND (detail->>'matches')::int = 1", [s.ref]);
    expect(audit.rowCount).toBe(1);
  });

  it("never shows a review or its reason: the investor reads 'refer to compliance' (no tipping-off)", async () => {
    const s = await subject();
    await w.su.query("INSERT INTO kyc.decisions (subject_id, status, reason, basis, decided_by) VALUES ($1, 'review', 'sanctions potential match', '{}', 'test')", [s.id]);
    const v = await lookup(c.support_agent, s.ref);
    expect((v.investor as { status?: string }).status).toBe("refer_compliance");
    expect(JSON.stringify(v)).not.toMatch(/sanction|review|match/i);
  });

  it("answers unknown and malformed references without detail, and audits misses too", async () => {
    expect(await lookup(c.support_agent, "00000000")).toEqual({ ok: true, found: false });
    expect(await lookup(c.support_agent, "xyz")).toMatchObject({ ok: false });
    const audit = await w.su.query("SELECT 1 FROM admin.audit WHERE action = 'support.lookup' AND detail->>'ref' = '00000000'");
    expect(audit.rowCount).toBe(1);
  });
});
