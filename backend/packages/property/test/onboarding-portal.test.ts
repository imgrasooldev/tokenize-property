import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapAdmins, officer, type TestOfficer } from "../../db/test/officers.ts";
import { sponsorState, verifyAudit } from "../src/service.ts";
import { draftSponsor, hex, identifiers, makeWorld, next, O, type World } from "./world.ts";

/**
 * PT Control onboarding desk (migration 0049 PO-1..PO-3): the S-01 maker actions through the
 * portal's database API, as the officer's bound handle, with the S-01 duty and state rules unchanged.
 */
let w: World;
let portal: pg.Client;

beforeAll(async () => {
  w = await makeWorld();
  portal = new pg.Client(w.settings);
  await portal.connect();
  // Exactly the rights of the portal's login (member of pt_admin_portal only).
  await portal.query("SET ROLE pt_admin_portal");
}, 180_000);

afterAll(async () => {
  await portal.end();
  await w.drop();
}, 180_000);

type Act = { ok: boolean; result?: unknown; error?: string; state?: string };
const act = async (o: TestOfficer, action: string, args: Record<string, unknown>): Promise<Act> =>
  (await portal.query<{ r: Act }>("SELECT admin.property_act($1, $2, $3::jsonb) AS r", [o.sessionHash, action, JSON.stringify(args)])).rows[0]?.r as Act;
const read = async <T>(o: TestOfficer, fn: string, ...args: unknown[]): Promise<T> =>
  (await portal.query<{ v: T }>(`SELECT admin.${fn}($1${args.map((_, i) => `, $${String(i + 2)}`).join("")}) AS v`, [o.sessionHash, ...args])).rows[0]?.v as T;

describe("S-01 maker work in PT Control (migration 0049)", () => {
  it("KYB evidence and transitions run as the officer, under the S-01 duty rules", async () => {
    const s = await draftSponsor(w);
    const onb1 = await officer(w.client, O.onb1, "ops_maker");
    const onb2 = await officer(w.client, O.onb2, "ops_maker");
    const comp1 = await officer(w.client, O.comp1, "compliance_officer");

    expect(await act(onb1, "submit_kyb", { sponsor: s.sponsorId, actingFor: s.repId })).toMatchObject({ ok: true, result: "kyb_submitted" });
    expect(await act(onb2, "screen_kyb", { sponsor: s.sponsorId, accept: true })).toMatchObject({ ok: true, result: "kyb_review" });
    expect(await act(onb2, "registration_check", { sponsor: s.sponsorId, method: "secp_eservices", outcome: "verified", evidence: hex() })).toMatchObject({ ok: true });
    // A risk rating needs the compliance duty: an operations maker is refused by S-01, audited, with the SQLSTATE.
    expect(await act(onb1, "risk", { sponsor: s.sponsorId, rating: "low", reasons: "listed group, simple ownership" })).toMatchObject({ ok: false, state: "42501" });
    expect(await act(comp1, "screening", { sponsor: s.sponsorId, provider: "mock-screen", listVersion: "un-2026-10", outcome: "clear", evidence: hex() })).toMatchObject({ ok: true });
    expect(await act(comp1, "risk", { sponsor: s.sponsorId, rating: "low", reasons: "listed group, simple ownership" })).toMatchObject({ ok: true });
    expect(await sponsorState(w.pool, s.sponsorId)).toBe("kyb_review");

    // The S-01 audit names the officer; the admin audit has every success and refusal; both chains verify.
    const by = await w.client.query<{ actor: string }>("SELECT actor FROM property.audit ORDER BY id DESC LIMIT 1");
    expect(by.rows[0]?.actor).toBe(O.comp1);
    const audit = await w.client.query<{ action: string; detail: { action?: string; decision?: string } }>(
      "SELECT action, detail FROM admin.audit WHERE action IN ('property.act', 'approval.refused') ORDER BY id",
    );
    expect(audit.rows.map((r) => `${r.action}:${r.detail.action ?? r.detail.decision ?? ""}`)).toEqual([
      "property.act:submit_kyb",
      "property.act:screen_kyb",
      "property.act:registration_check",
      "approval.refused:risk",
      "property.act:screening",
      "property.act:risk",
    ]);
    expect((await w.client.query("SELECT * FROM admin.verify_audit()")).rows).toEqual([]);
    expect(await verifyAudit(w.pool)).toEqual([]);

    // The sponsor file: evidence and history, never the sealed name or address.
    const file = await read<{ state: string; people: unknown[]; registrationChecks: unknown[]; risk: unknown[]; events: { code: string }[] }>(comp1, "onboarding_sponsor", s.sponsorId);
    expect(file).toMatchObject({ state: "kyb_review" });
    expect(file.people).toHaveLength(3);
    expect(file.registrationChecks).toHaveLength(1);
    expect(file.events.map((e) => e.code)).toEqual(["K2", "K1"]);
    expect(JSON.stringify(file)).not.toMatch(/Zeta Holdings|Testing Avenue/);
  });

  it("a property file is created, edited and documented from the portal; an unknown action and a missing vault file are refused", async () => {
    const s = await draftSponsor(w);
    const onb1 = await officer(w.client, O.onb1, "ops_maker");
    const created = await act(onb1, "create_property", { sponsor: s.sponsorId, actingFor: s.repId, ids: identifiers(next()) });
    expect(created).toMatchObject({ ok: true });
    const propertyId = String(created.result);
    expect(await act(onb1, "update_property", { property: propertyId, actingFor: s.repId, ids: { building: "Portal Plaza" } })).toMatchObject({ ok: true });

    // A document is linked only from a file that is in the vault.
    const sha = hex();
    expect(await act(onb1, "add_document", { sponsor: s.sponsorId, property: propertyId, type: "title_deed", sha256: sha, actingFor: s.repId })).toMatchObject({
      ok: false,
      state: "P0002",
    });
    await w.client.query(
      "INSERT INTO vault.objects (sha256, size_bytes, media_type, key_version, wrapped_key, nonce, created_by) VALUES (decode($1, 'hex'), 2048, 'application/pdf', 1, $2, $3, 'test')",
      [sha, Buffer.alloc(60, 1), Buffer.alloc(12, 2)],
    );
    expect(await act(onb1, "add_document", { sponsor: s.sponsorId, property: propertyId, type: "title_deed", sha256: sha, actingFor: s.repId })).toMatchObject({ ok: true });
    const prop = await read<{ building: string; documents: { type: string; sha256: string }[]; vault: { sha256: string }[] }>(onb1, "onboarding_property", propertyId);
    expect(prop.building).toBe("Portal Plaza");
    expect(prop.documents.map((d) => `${d.type}:${d.sha256}`)).toContain(`title_deed:${sha}`);
    expect(prop.vault.map((v) => v.sha256)).not.toContain(sha);

    expect(await act(onb1, "drop_everything", { property: propertyId })).toMatchObject({ ok: false, state: "22023" });

    const desk = await read<{ me: { duties: string[] }; properties: { id: string }[]; sponsors: { id: string }[] }>(await officer(w.client, O.onb1, "ops_maker"), "onboarding");
    expect(desk.me.duties).toContain("onboarding");
    expect(desk.properties.map((p) => p.id)).toContain(propertyId);
    expect(desk.sponsors.map((p) => p.id)).toContain(s.sponsorId);
  });

  it("a property manager acts only on assigned properties and never on sponsor files; duties need an administrator", async () => {
    const s = await draftSponsor(w);
    const manager = await officer(w.client, `mgr-${String(next())}`, "property_manager");
    expect(await act(manager, "submit_kyb", { sponsor: s.sponsorId, actingFor: s.repId })).toMatchObject({ ok: false, state: "42501" });
    expect(await read(manager, "onboarding_sponsor", s.sponsorId)).toBeNull();
    expect((await read<{ sponsors: unknown[] }>(manager, "onboarding")).sponsors).toEqual([]);

    // Duties: an operations maker may not touch them; an administrator asks, a second one decides.
    const onb1 = await officer(w.client, O.onb1, "ops_maker");
    await expect(act(onb1, "request_duty", { officer: O.onb2, duty: "technical", reason: "building surveyor on the team" })).rejects.toMatchObject({ code: "42501" });
    const [a, b] = await bootstrapAdmins(w.client);
    const asked = await act(a, "request_duty", { officer: O.onb2, duty: "technical", reason: "building surveyor on the team" });
    expect(asked).toMatchObject({ ok: true });
    expect(await act(a, "decide_duty", { id: asked.result, approve: true, reason: "checked against the HR record" })).toMatchObject({ ok: false, state: "42501" });
    expect(await act(b, "decide_duty", { id: asked.result, approve: true, reason: "checked against the HR record" })).toMatchObject({ ok: true, result: "active" });
    const panel = await read<{ duties: { officer: string; duty: string; status: string }[]; dutyRoles: Record<string, string[]> }>(b, "property_duties");
    expect(panel.duties).toContainEqual(expect.objectContaining({ officer: O.onb2, duty: "technical", status: "active" }));
    expect(panel.dutyRoles.trustee).toEqual(["trustee_officer"]);
    await expect(read(onb1, "property_duties")).rejects.toMatchObject({ code: "42501" });
  });
});
