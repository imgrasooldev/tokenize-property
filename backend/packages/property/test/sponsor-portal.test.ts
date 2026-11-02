import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminSettings } from "../../db/test/helpers.ts";
import { draftSponsor, makeWorld, type World } from "./world.ts";

/**
 * Migration 0048 (SP-1..SP-3): a sponsor's representative works on the website through
 * session-bound sponsorweb.* functions only: sees the KYB file and properties without any internal
 * finding, submits KYB, creates and updates a property, stores a document through a one-time
 * upload ticket that the vault redeems once; a website user who is not a representative is refused.
 */
let w: World;
let web: pg.Client;
let vaultRole: pg.Client;
const role = `pt_web_sp_${randomBytes(4).toString("hex")}`;
const vrole = `pt_vault_sp_${randomBytes(4).toString("hex")}`;
const password = randomBytes(24).toString("base64url");
const sha = (s: string | Buffer): Buffer => createHash("sha256").update(s).digest();

beforeAll(async () => {
  w = await makeWorld();
  for (const [r, group] of [
    [role, "pt_web"],
    [vrole, "pt_svc_vault"],
  ] as const) {
    await w.client.query(`CREATE ROLE ${r} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${w.client.escapeLiteral(password)}`);
    await w.client.query(`GRANT ${group} TO ${r} WITH INHERIT TRUE, SET FALSE`);
  }
  web = new pg.Client({ ...w.settings, user: role, password });
  await web.connect();
  vaultRole = new pg.Client({ ...w.settings, user: vrole, password });
  await vaultRole.connect();
}, 240_000);

afterAll(async () => {
  await web.end();
  await vaultRole.end();
  await w.drop();
  const root = new pg.Client(adminSettings());
  await root.connect();
  await root.query(`DROP ROLE IF EXISTS ${role}`);
  await root.query(`DROP ROLE IF EXISTS ${vrole}`);
  await root.end();
}, 240_000);

/** A website session for a KYC subject. */
async function sessionFor(subject: string | null): Promise<Buffer> {
  const i = await w.client.query<{ id: string }>("INSERT INTO webdemo.investors (display_name, wallet_address, kyc_status, kyc_subject) VALUES ('Sponsor Rep', $1, 'verified', $2) RETURNING id", [
    `0x${randomBytes(20).toString("hex")}`,
    subject,
  ]);
  const t = randomBytes(32).toString("base64url");
  await web.query("SELECT webauth.web_start_session($1, $2, 'signup')", [sha(t), i.rows[0]?.id]);
  return sha(t);
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => (e as { code?: string }).code,
  );

describe("sponsor portal (0048)", () => {
  it("a representative sees the file, submits KYB, creates a property and stores a document; nothing internal is shown", async () => {
    const s = await draftSponsor(w);
    const me = await sessionFor(s.rep.id);
    type Overview = { id: string; state: string; powers: string[]; documents: unknown[]; properties: { id: string; state: string; missing: string | null; documents: unknown[] }[] }[];
    const view = async () => (await web.query<{ v: Overview }>("SELECT sponsorweb.overview($1) AS v", [me])).rows[0]?.v ?? [];
    const mine = (await view()).find((x) => x.id === s.sponsorId);
    expect(mine).toMatchObject({ state: "kyb_draft", powers: ["submit", "upload", "respond", "withdraw"] });
    expect(JSON.stringify(mine)).not.toMatch(/screen|risk|duplicate|fraud|fmu|reviewer/i);

    const act = (sponsor: string | null, property: string | null, action: string, ids: object | null = null, reason: string | null = null) =>
      web.query<{ r: Record<string, unknown> }>("SELECT sponsorweb.act($1, $2, $3, $4, $5::jsonb, $6) AS r", [me, sponsor, property, action, ids ? JSON.stringify(ids) : null, reason]);
    expect((await act(s.sponsorId, null, "submit_kyb")).rows[0]?.r).toMatchObject({ ok: true, state: "kyb_submitted" });
    const created = (await act(s.sponsorId, null, "create_property", { province: "punjab", district: "Lahore", building: "Zeta Tower" })).rows[0]?.r;
    expect(created).toMatchObject({ ok: true });
    const property = String(created?.property);
    expect((await act(null, property, "update_property", { society: "DHA Phase 6", plot_no: "12-B" })).rows[0]?.r).toMatchObject({ ok: true });
    const p = (await view()).find((x) => x.id === s.sponsorId)?.properties.find((x) => x.id === property);
    expect(p?.state).toBe("draft");
    expect(p?.missing).toMatch(/identifiers incomplete/);

    // Upload: ticket -> the vault redeems it once for exactly that file -> recorded as a property document.
    const file = Buffer.from(`%PDF-1.7 title deed ${randomBytes(4).toString("hex")}`);
    const ticket = (await web.query<{ t: string }>("SELECT sponsorweb.upload_ticket($1, $2, $3, 'title_deed', $4, $5, 'application/pdf') AS t", [
      me, s.sponsorId, property, sha(file), file.length,
    ])).rows[0]?.t ?? "";
    expect((await vaultRole.query<{ ok: boolean }>("SELECT vault.redeem_upload_ticket($1, $2, $3, 'application/pdf') AS ok", [ticket, sha(randomBytes(8)), file.length])).rows[0]?.ok).toBe(false);
    expect((await vaultRole.query<{ ok: boolean }>("SELECT vault.redeem_upload_ticket($1, $2, $3, 'application/pdf') AS ok", [ticket, sha(file), file.length])).rows[0]?.ok).toBe(true);
    expect((await vaultRole.query<{ ok: boolean }>("SELECT vault.redeem_upload_ticket($1, $2, $3, 'application/pdf') AS ok", [ticket, sha(file), file.length])).rows[0]?.ok).toBe(false);
    // The vault stores the encrypted file (here: its metadata row, as the vault service would).
    await w.client.query("SELECT vault.register($1, $2, 'application/pdf', 1::smallint, $3, $4, 'sponsor-upload')", [sha(file), file.length, randomBytes(60), randomBytes(12)]);
    expect((await web.query<{ r: { ok: boolean } }>("SELECT sponsorweb.add_document($1, $2) AS r", [me, ticket])).rows[0]?.r).toMatchObject({ ok: true });
    expect(await code(web.query("SELECT sponsorweb.add_document($1, $2)", [me, ticket]))).toBe("P0002");
    const doc = await w.client.query<{ store_ref: string; uploaded_by: string }>("SELECT store_ref, uploaded_by FROM property.documents WHERE sha256 = $1", [sha(file)]);
    expect(doc.rows[0]?.store_ref).toBe(`vault://${sha(file).toString("hex")}`);
    expect(doc.rows[0]?.uploaded_by).toMatch(/^web:/);
    expect((await view()).find((x) => x.id === s.sponsorId)?.properties.find((x) => x.id === property)?.documents).toHaveLength(1);
  });

  it("someone who does not act for the sponsor is refused; the website reaches nothing else", async () => {
    const s = await draftSponsor(w);
    const stranger = await sessionFor(null);
    const other = await sessionFor((await draftSponsor(w)).rep.id);
    expect((await web.query<{ v: unknown }>("SELECT sponsorweb.overview($1) AS v", [stranger])).rows[0]?.v).toBeNull();
    expect(await code(web.query("SELECT sponsorweb.act($1, $2, NULL, 'submit_kyb', NULL, NULL)", [other, s.sponsorId]))).toBe("42501");
    expect(await code(web.query("SELECT sponsorweb.upload_ticket($1, $2, NULL, 'board_resolution', $3, 10, 'application/pdf')", [other, s.sponsorId, sha("x")]))).toBe("42501");
    expect(await code(web.query("SELECT * FROM property.sponsors"))).toBe("42501");
    // The in-person rule cannot be borrowed: the website cannot call the S-01 functions itself, marker or not.
    await web.query("SELECT set_config('sponsorweb.actor', 'web:00000000-0000-0000-0000-000000000000', false)");
    expect(await code(web.query("SELECT property.submit_kyb($1, 'web:00000000-0000-0000-0000-000000000000', 1)", [s.sponsorId]))).toBe("42501");
    expect(await code(web.query("SELECT * FROM sponsorweb.upload_tickets"))).toBe("42501");
    expect(await code(web.query("SELECT vault.redeem_upload_ticket('x', $1, 1, 'application/pdf')", [sha("x")]))).toBe("42501");
  });
});
