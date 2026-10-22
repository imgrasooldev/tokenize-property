import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditActions, cast, createWorld, verify, type Actor, type Cast, type World } from "../support/world";

/**
 * T-046 database rules (migration 0026) through the portal's own login: the portal reaches the
 * committee, P8 and offering vote functions only through admin.*; every vote needs a fresh step-up;
 * refusals are audited and carry the backend's SQLSTATE; investment-committee votes, the close of a
 * meeting and the trustee's P8 decision under an officer's handle are refused outside the portal.
 * The full flows (quorum, independence, digests, maker-checker, binding) run in the backend tests
 * (property/test/property-db.test.ts, offering/test/seed.test.ts) against real files.
 */
let w: World;
let c: Cast;
let counter = Date.now();
type R = { ok: boolean; status?: string; error?: string; state?: string };

beforeAll(async () => {
  w = await createWorld();
  c = await cast(w);
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

async function stepUp(a: Actor, fresh: boolean): Promise<void> {
  await w.portal.query("SELECT admin.record_step_up($1, $2, $3)", [a.sessionHash, a.credentialId, ++counter]);
  if (!fresh) {
    // Test-only ageing on a scratch database (the guard keeps step-ups forward-only in production).
    await w.su.query("ALTER TABLE admin.sessions DISABLE TRIGGER sessions_guard");
    await w.su.query("UPDATE admin.sessions SET step_up_at = step_up_at - interval '5 minutes 1 second' WHERE token_hash = $1", [a.sessionHash]);
    await w.su.query("ALTER TABLE admin.sessions ENABLE TRIGGER sessions_guard");
  }
}

const D = `'\\x${"a".repeat(64)}'`;
const DECISIONS: [string, keyof Cast, string][] = [
  ["open_committee", "ops_checker", "SELECT admin.open_committee($1, gen_random_uuid(), 'opening the committee meeting') AS r"],
  ["committee_vote", "ops_maker", `SELECT admin.committee_vote($1, 999999, 'approve', 'file reviewed, agree', ${D}) AS r`],
  ["close_committee", "compliance_officer", `SELECT admin.close_committee($1, 999999, '${"c".repeat(64)}', 'votes counted, minutes filed', ${D}) AS r`],
  ["decide_property_trustee", "trustee_officer", `SELECT admin.decide_property_trustee($1, gen_random_uuid(), 1, 'accept', NULL, 'structure accepted', ${D}) AS r`],
  ["vote_offering_request", "ops_checker", `SELECT admin.vote_offering_request($1, 999999, 'approve', 'terms checked, agree', ${D}) AS r`],
  ["return_offering", "compliance_officer", `SELECT admin.return_offering($1, 999999, 'request expired, back to draft', ${D}) AS r`],
];

describe("committee, P8 and offering votes in the portal (migration 0026)", () => {
  it("the portal login cannot call the backend's vote functions or read their tables", async () => {
    for (const sql of [
      "SELECT property.cast_vote(1, 'x.y', 'approve', NULL)",
      "SELECT property.close_ic(1, 'x.y', '\\x00')",
      "SELECT property.open_ic(gen_random_uuid(), 'x.y')",
      "SELECT property.trustee_decide(gen_random_uuid(), 'x.y', 1, true, NULL, 'reason long enough')",
      "SELECT offering.decide(1, 'x.y', true, 'reason long enough')",
      "SELECT offering.return_offering(gen_random_uuid(), 'x.y', 'reason long enough')",
      "SELECT * FROM property.ic_votes",
      "SELECT * FROM property.trustee_decisions",
      "SELECT admin.committee_digest(1, true)",
      "SELECT admin.vote_refused(NULL, 'x', 'x', 'x', 'x', 'x')",
    ]) {
      expect(await code(w.portal.query(sql)), sql).toBe("42501");
    }
  });

  it("every vote needs a step-up younger than five minutes", async () => {
    for (const [fn, who, sql] of DECISIONS) {
      // eslint-disable-next-line security/detect-object-injection
      const a = c[who];
      await stepUp(a, false);
      expect(await code(w.portal.query(sql, [a.sessionHash])), fn).toBe("PTS01");
      await stepUp(a, true);
      expect(await code(w.portal.query(sql, [a.sessionHash])), fn).toBeUndefined();
    }
  });

  it("refusals are audited and carry the backend's SQLSTATE", async () => {
    const since = (await auditActions(w)).at(-1)?.id ?? "0";
    await stepUp(c.ops_checker, true);
    const unknown = await w.portal.query<{ r: R }>(`SELECT admin.committee_vote($1, 999999, 'approve', 'file reviewed, agree', ${D}) AS r`, [c.ops_checker.sessionHash]);
    expect(unknown.rows[0]?.r).toMatchObject({ ok: false, error: "unknown meeting", state: "P0002" });
    const badVote = await w.portal.query<{ r: R }>(`SELECT admin.committee_vote($1, 999999, 'yes', 'file reviewed, agree', ${D}) AS r`, [c.ops_checker.sessionHash]);
    expect(badVote.rows[0]?.r).toMatchObject({ ok: false, state: "22023" });
    const noDuty = await w.portal.query<{ r: R }>("SELECT admin.open_committee($1, gen_random_uuid(), 'opening the committee meeting') AS r", [c.ops_checker.sessionHash]);
    expect(noDuty.rows[0]?.r).toMatchObject({ ok: false, state: "42501" });
    expect(noDuty.rows[0]?.r.error).toMatch(/duty/);
    const badMinutes = await w.portal.query<{ r: R }>(`SELECT admin.close_committee($1, 999999, 'not-a-hash', 'votes counted, minutes filed', ${D}) AS r`, [
      c.ops_checker.sessionHash,
    ]);
    expect(badMinutes.rows[0]?.r).toMatchObject({ ok: false, state: "22023" });
    await stepUp(c.trustee_officer, true);
    const badChoice = await w.portal.query<{ r: R }>(`SELECT admin.decide_property_trustee($1, gen_random_uuid(), 1, 'approve', NULL, 'structure accepted', ${D}) AS r`, [
      c.trustee_officer.sessionHash,
    ]);
    expect(badChoice.rows[0]?.r).toMatchObject({ ok: false, state: "22023" });
    const refused = (await auditActions(w, Number(since))).filter((a) => a.action === "approval.refused").map((a) => a.detail.kind);
    expect(refused).toEqual(["committee.vote", "committee.vote", "committee.open", "committee.close", "trustee.property"]);
    expect(await verify(w)).toEqual([]);
  });

  it("committee votes, closes and trustee decisions under an officer's handle are refused outside the portal", async () => {
    const officerHandle = c.ops_checker.handle;
    // BEFORE INSERT triggers run before the foreign keys: an officer's handle is refused by the binding,
    // any other name gets as far as the (missing) meeting or property.
    expect(await code(w.su.query("INSERT INTO property.ic_votes (meeting_id, member, independent, conflict, vote) VALUES (999999, $1, false, false, 'approve')", [officerHandle]))).toBe(
      "42501",
    );
    expect(await code(w.su.query("INSERT INTO property.ic_votes (meeting_id, member, independent, conflict, vote) VALUES (999999, 'cli:operator', false, false, 'approve')"))).toBe(
      "23503",
    );
    expect(
      await code(
        w.su.query("INSERT INTO property.trustee_decisions (property_id, structure_id, trustee, decision, reason) VALUES (gen_random_uuid(), 999999, $1, 'accept', 'accepted from the command line')", [
          c.trustee_officer.handle,
        ]),
      ),
    ).toBe("42501");
    const err = await w.su
      .query("INSERT INTO property.ic_votes (meeting_id, member, independent, conflict, vote) VALUES (999999, $1, false, false, 'approve')", [officerHandle])
      .catch((e: unknown) => e as Error);
    expect((err as Error).message).toMatch(/officer of the admin portal/);
  });
});
