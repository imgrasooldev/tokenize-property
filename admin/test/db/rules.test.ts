import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_CONFLICTS, ROLE_PERMISSIONS, ROLES, conflicts, type Role } from "../../src/lib/permissions";
import { auditActions, cast, createWorld, enrol, fakeKey, invite, login, sha, token, verify, type Actor, type Cast, type World } from "../support/world";

/**
 * Database rules of the admin portal migration: role matrix, segregation of duties, maker-checker,
 * bootstrap and enrolment links, sessions, step-up, credentials, and privileges.
 */
let w: World;
let c: Cast;

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

async function requestId(by: Actor, kind: string, officer: string | null, role: string | null, handle?: string): Promise<string> {
  const { rows } = await w.portal.query<{ id: string }>("SELECT admin.request_change($1, $2, $3, $4, $5, $6, $7) AS id", [
    by.sessionHash,
    kind,
    officer,
    role,
    handle ?? null,
    handle ? "New Person" : null,
    "a reason that is long enough",
  ]);
  return rows[0]?.id ?? "";
}

async function decide(by: Actor, id: string, decision = "approve"): Promise<string> {
  const { rows } = await w.portal.query<{ s: string }>("SELECT admin.decide_change($1, $2, $3, 'checker reason here') AS s", [by.sessionHash, id, decision]);
  return rows[0]?.s ?? "";
}

describe("role matrix", () => {
  it("the portal's copy equals the database (permissions and conflicts)", async () => {
    const { rows } = await w.portal.query<{ kind: string; a: string; b: string }>("SELECT * FROM admin.role_matrix()");
    const perms = rows.filter((r) => r.kind === "permission").map((r) => `${r.a}:${r.b}`).sort();
    const ts = Object.entries(ROLE_PERMISSIONS).flatMap(([r, ps]) => ps.map((p) => `${r}:${p}`)).sort();
    expect(perms).toEqual(ts);
    const confl = rows.filter((r) => r.kind === "conflict").map((r) => `${r.a}+${r.b}`).sort();
    expect(confl).toEqual(ROLE_CONFLICTS.map(([a, b]) => `${a}+${b}`).sort());
  });

  it("no role combines approving money or token actions with administering officers or auditing", () => {
    expect(conflicts("ops_maker", "ops_checker")).toBe(true);
    for (const r of ROLES) if (r !== "trustee_officer") expect(conflicts("trustee_officer", r)).toBe(true);
    for (const r of ROLES) if (r !== "auditor") expect(conflicts("auditor", r)).toBe(true);
    for (const r of ["ops_maker", "ops_checker", "compliance_officer", "trustee_officer"] as Role[]) expect(conflicts("admin", r)).toBe(true);
  });
});

describe("segregation of duties (enforced by the database for any writer)", () => {
  it("refuses at request time every conflicting pair, allows the one compatible pair", async () => {
    for (const [held, actor] of [
      ["ops_maker", c.ops_maker],
      ["ops_checker", c.ops_checker],
      ["compliance_officer", c.compliance_officer],
      ["trustee_officer", c.trustee_officer],
      ["auditor", c.auditor],
    ] as const) {
      for (const role of ROLES) {
        if (role === held) continue;
        if (conflicts(held, role)) {
          expect(await code(requestId(c.admin, "grant", actor.officerId, role)), `${held} + ${role}`).toBe("23514");
        } else {
          // The one compatible pair: the request is accepted (and rejected again to keep the world unchanged).
          await decide(c.admin2, await requestId(c.admin, "grant", actor.officerId, role), "reject");
        }
      }
    }
  });

  it("the grant trigger refuses a conflict even for a superuser who forges an approved change", async () => {
    // In a transaction rolled back afterwards: the forged change itself would (rightly) show up in verify_audit().
    await w.su.query("BEGIN");
    const { rows } = await w.su.query<{ id: string }>(
      `INSERT INTO admin.changes (kind, officer_id, role, reason, requested_by, status, decided_by, decision_reason, decided_at)
       VALUES ('grant', $1, 'ops_checker', 'forged by a rogue DBA', $2, 'approved', $3, 'forged approval reason', now()) RETURNING id`,
      [c.ops_maker.officerId, c.admin.officerId, c.admin2.officerId],
    );
    const err = await w.su
      .query("INSERT INTO admin.role_grants (officer_id, role, granted_change) VALUES ($1, 'ops_checker', $2)", [c.ops_maker.officerId, rows[0]?.id])
      .then(
        () => "inserted",
        (e: unknown) => (e instanceof Error ? e.message : "?"),
      );
    await w.su.query("ROLLBACK");
    expect(err).toMatch(/segregation of duties/);
  });

  it("refuses a grant without an approved change, even by a superuser", async () => {
    const err = await w.su.query("INSERT INTO admin.role_grants (officer_id, role) VALUES ($1, 'compliance_officer')", [c.ops_checker.officerId]).then(
      () => "inserted",
      (e: unknown) => (e instanceof Error ? e.message : "?"),
    );
    expect(err).toMatch(/approved change/);
  });

  it("two concurrent approvals of conflicting roles: exactly one succeeds", async () => {
    const fresh = await invite(w, c.admin, c.admin2, "race.target", "compliance_officer");
    // Revoke compliance first so both maker and checker are individually allowed.
    await decide(c.admin2, await requestId(c.admin, "revoke", fresh.officerId, "compliance_officer"));
    const a = await requestId(c.admin, "grant", fresh.officerId, "ops_maker");
    const b = await requestId(c.admin, "grant", fresh.officerId, "ops_checker");
    const results = await Promise.allSettled([decide(c.admin2, a), decide(c.admin2, b)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const { rows } = await w.su.query("SELECT role FROM admin.role_grants WHERE officer_id = $1 AND revoked_at IS NULL", [fresh.officerId]);
    expect(rows).toHaveLength(1);
  });
});

describe("maker-checker for officer changes", () => {
  it("the requester cannot decide their own request", async () => {
    const id = await requestId(c.admin, "grant", c.compliance_officer.officerId, "ops_checker");
    expect(await code(decide(c.admin, id))).toBe("23514");
    expect(await decide(c.admin2, id, "reject")).toBe("rejected");
  });

  it("nobody requests a change to their own account", async () => {
    expect(await code(requestId(c.admin, "disable", c.admin.officerId, null))).toBe("23514");
  });

  it("non-administrators can neither request nor decide", async () => {
    for (const r of ["ops_maker", "ops_checker", "compliance_officer", "trustee_officer", "auditor"] as const) {
      // eslint-disable-next-line security/detect-object-injection
      expect(await code(requestId(c[r], "grant", c.ops_maker.officerId, "auditor"))).toBe("42501");
    }
    const id = await requestId(c.admin, "grant", c.compliance_officer.officerId, "ops_checker");
    expect(await code(decide(c.auditor, id))).toBe("42501");
    await decide(c.admin2, id, "reject");
  });

  it("approval needs a step-up less than five minutes old (checked in the database)", async () => {
    const id = await requestId(c.admin, "grant", c.compliance_officer.officerId, "ops_checker");
    await w.su.query("ALTER TABLE admin.sessions DISABLE TRIGGER sessions_guard");
    await w.su.query("UPDATE admin.sessions SET step_up_at = step_up_at - interval '6 minutes', created_at = created_at - interval '6 minutes', expires_at = expires_at - interval '6 minutes' WHERE token_hash = $1", [c.admin2.sessionHash]);
    await w.su.query("ALTER TABLE admin.sessions ENABLE TRIGGER sessions_guard");
    expect(await code(decide(c.admin2, id))).toBe("PTS01");
    // A fresh assertion recorded on the session (the portal verified it) opens the window again.
    await w.portal.query("SELECT admin.record_step_up($1, $2, $3)", [c.admin2.sessionHash, c.admin2.credentialId, 10_000]);
    expect(await decide(c.admin2, id)).toBe("approved");
    // The other officer's key cannot be used for this session's step-up.
    const { rows } = await w.portal.query<{ at: Date | null }>("SELECT admin.record_step_up($1, $2, $3) AS at", [c.admin2.sessionHash, c.admin.credentialId, 10_001]);
    expect(rows[0]?.at).toBeNull();
    expect((await auditActions(w)).at(-1)?.action).toBe("stepup.failed");
  });

  it("an expired request cannot be approved", async () => {
    const id = await requestId(c.admin, "grant", c.ops_checker.officerId, "compliance_officer");
    await w.su.query("ALTER TABLE admin.changes DISABLE TRIGGER changes_guard");
    await w.su.query("UPDATE admin.changes SET requested_at = requested_at - interval '25 hours', expires_at = expires_at - interval '25 hours' WHERE id = $1", [id]);
    await w.su.query("ALTER TABLE admin.changes ENABLE TRIGGER changes_guard");
    expect(await decide(c.admin2, id)).toBe("expired");
  });

  it("at least two active administrators must remain", async () => {
    expect(await code(requestId(c.admin, "disable", c.admin2.officerId, null))).toBe("23514");
    expect(await code(requestId(c.admin, "revoke", c.admin2.officerId, "admin"))).toBe("23514");
  });

  it("disabling an officer ends their session and blocks sign-in", async () => {
    const victim = await invite(w, c.admin, c.admin2, "leaver", "ops_maker");
    await decide(c.admin2, await requestId(c.admin, "disable", victim.officerId, null));
    const { rows } = await w.portal.query("SELECT * FROM admin.authorize($1, NULL, NULL, false)", [victim.sessionHash]);
    expect(rows).toHaveLength(0);
    const { rows: again } = await w.portal.query<{ id: string | null }>("SELECT admin.start_session($1, $2, 99999) AS id", [sha(token()), victim.credentialId]);
    expect(again[0]?.id).toBeNull();
    expect((await auditActions(w)).at(-1)?.action).toBe("login.failed");
  });
});

describe("bootstrap and enrolment links", () => {
  it("bootstrap is closed after two bootstrap administrators and once other officers exist", async () => {
    expect(await code(w.cli.query("SELECT admin.bootstrap_admin('third.admin', 'Third Admin', $1, 'cli:test')", [sha(token())]))).toBe("42501");
  });

  it("an enrolment link works once, expires, and a new link revokes the old one", async () => {
    const id = await requestId(c.admin, "invite", null, "auditor", "late.auditor");
    await decide(c.admin2, id);
    const first = token();
    const second = token();
    await w.cli.query("SELECT admin.issue_enrolment('late.auditor', $1, 'cli:test', 30)", [sha(first)]);
    await w.cli.query("SELECT admin.issue_enrolment('late.auditor', $1, 'cli:test', 30)", [sha(second)]);
    expect(await enrol(w, first, fakeKey())).toBeFalsy(); // revoked
    expect(await code(w.cli.query("SELECT admin.issue_enrolment('late.auditor', $1, 'cli:test', 31)", [sha(token())]))).toBe("23514");
    await enrol(w, second, fakeKey());
    expect(await enrol(w, second, fakeKey())).toBeFalsy(); // used
    // Already enrolled: no further links.
    expect(await code(w.cli.query("SELECT admin.issue_enrolment('late.auditor', $1, 'cli:test', 30)", [sha(token())]))).toBe("23514");
  });

  it("an expired link is refused", async () => {
    await decide(c.admin2, await requestId(c.admin, "invite", null, "auditor", "slow.auditor"));
    const t = token();
    await w.cli.query("SELECT admin.issue_enrolment('slow.auditor', $1, 'cli:test', 5)", [sha(t)]);
    await w.su.query("ALTER TABLE admin.enrolments DISABLE TRIGGER enrolments_guard");
    await w.su.query("UPDATE admin.enrolments SET issued_at = issued_at - interval '10 minutes', expires_at = expires_at - interval '10 minutes' WHERE token_hash = $1", [sha(t)]);
    await w.su.query("ALTER TABLE admin.enrolments ENABLE TRIGGER enrolments_guard");
    expect(await enrol(w, t, fakeKey())).toBeFalsy();
    expect((await auditActions(w)).at(-1)?.action).toBe("enrol.failed");
  });

  it("refuses synced passkeys and keys that did not verify the user", async () => {
    await decide(c.admin2, await requestId(c.admin, "invite", null, "auditor", "synced.user"));
    const t = token();
    await w.cli.query("SELECT admin.issue_enrolment('synced.user', $1, 'cli:test', 30)", [sha(t)]);
    expect(await enrol(w, t, fakeKey(), { deviceType: "multiDevice", backedUp: true })).toBeFalsy();
    expect(await enrol(w, t, fakeKey(), { uv: false })).toBeFalsy();
    const reasons = (await auditActions(w)).slice(-2).map((a) => String(a.detail.reason));
    expect(reasons[0]).toMatch(/synced passkey refused/);
    expect(reasons[1]).toMatch(/user not verified/);
    // The link is still unused: a proper key can enrol with it.
    expect(await enrol(w, t, fakeKey())).toBeTruthy();
  });

  it("the CLI role cannot use portal functions and the portal cannot bootstrap", async () => {
    expect(await code(w.cli.query("SELECT admin.ops_overview($1)", [c.auditor.sessionHash]))).toBe("42501");
    expect(await code(w.portal.query("SELECT admin.bootstrap_admin('x.y.z', 'X Y', $1, 'p')", [sha(token())]))).toBe("42501");
    expect(await code(w.portal.query("SELECT admin.issue_enrolment('auditor', $1, 'p', 30)", [sha(token())]))).toBe("42501");
  });
});

describe("sessions", () => {
  async function valid(hash: Buffer): Promise<boolean> {
    return (await w.portal.query("SELECT * FROM admin.authorize($1, NULL, NULL, false)", [hash])).rows.length === 1;
  }

  it("ends after 15 minutes idle", async () => {
    const o = await invite(w, c.admin, c.admin2, "idle.one", "ops_maker");
    await w.su.query("ALTER TABLE admin.sessions DISABLE TRIGGER sessions_guard");
    await w.su.query("UPDATE admin.sessions SET last_seen_at = now() - interval '16 minutes' WHERE token_hash = $1", [o.sessionHash]);
    await w.su.query("ALTER TABLE admin.sessions ENABLE TRIGGER sessions_guard");
    expect(await valid(o.sessionHash)).toBe(false);
    const { rows } = await w.su.query<{ end_reason: string }>("SELECT end_reason FROM admin.sessions WHERE token_hash = $1", [o.sessionHash]);
    expect(rows[0]?.end_reason).toBe("idle");
    expect(await code(w.portal.query("SELECT admin.ops_overview($1)", [o.sessionHash]))).toBe("42501");
  });

  it("ends after 8 hours even when active", async () => {
    const o = await invite(w, c.admin, c.admin2, "long.one", "ops_maker");
    await w.su.query("ALTER TABLE admin.sessions DISABLE TRIGGER sessions_guard");
    await w.su.query(
      "UPDATE admin.sessions SET created_at = now() - interval '8 hours 1 minute', expires_at = now() - interval '1 minute', last_seen_at = now() WHERE token_hash = $1",
      [o.sessionHash],
    );
    await w.su.query("ALTER TABLE admin.sessions ENABLE TRIGGER sessions_guard");
    expect(await valid(o.sessionHash)).toBe(false);
    const { rows } = await w.su.query<{ end_reason: string }>("SELECT end_reason FROM admin.sessions WHERE token_hash = $1", [o.sessionHash]);
    expect(rows[0]?.end_reason).toBe("absolute");
  });

  it("a new sign-in supersedes the previous session; logout ends it", async () => {
    const key = fakeKey();
    await decide(c.admin2, await requestId(c.admin, "invite", null, "auditor", "two.logins"));
    const t = token();
    await w.cli.query("SELECT admin.issue_enrolment('two.logins', $1, 'cli:test', 30)", [sha(t)]);
    await enrol(w, t, key);
    const s1 = await login(w, key);
    const s2 = await login(w, key);
    expect(await valid(s1.sessionHash)).toBe(false);
    expect(await valid(s2.sessionHash)).toBe(true);
    await w.portal.query("SELECT admin.end_session($1, 'logout')", [s2.sessionHash]);
    expect(await valid(s2.sessionHash)).toBe(false);
  });

  it("a signature counter that does not increase is refused and alerted (cloned key)", async () => {
    const before = (await auditActions(w)).at(-1)?.id ?? "0";
    const { rows } = await w.portal.query<{ id: string | null }>("SELECT admin.start_session($1, $2, 1) AS id", [sha(token()), c.auditor.credentialId]);
    expect(rows[0]?.id).toBeNull();
    const after = await auditActions(w, Number(before));
    expect(after.some((a) => a.action === "login.counter_regression")).toBe(true);
  });

  it("an unknown session hash gets nothing", async () => {
    expect(await valid(sha(token()))).toBe(false);
  });
});

describe("privileges of the portal's database role", () => {
  it("has no direct access to any table (admin or operational schemas)", async () => {
    for (const t of ["admin.officers", "admin.sessions", "admin.audit", "admin.credentials", "signer.audit", "recon.audit", "ledger.journal", "kyc.subjects", "bank.payees", "outbox.commands"]) {
      expect(await code(w.portal.query(`SELECT 1 FROM ${t} LIMIT 1`)), t).toBe("42501");
    }
    expect(await code(w.portal.query("INSERT INTO admin.audit (at, actor, action, detail, prev_hash, hash) VALUES (now(), 'x', 'x.x.x', '{}', '\\x00', '\\x00')"))).toBe("42501");
    expect(await code(w.portal.query("SELECT admin.audit_append('x', 'forged.entry', '{}')"))).toBe("42501");
  });

  it("is not a superuser and inherits only pt_admin_portal", async () => {
    const { rows } = await w.su.query<{ rolsuper: boolean; roles: string[] }>(
      `SELECT r.rolsuper, array(SELECT b.rolname FROM pg_auth_members m JOIN pg_roles b ON b.oid = m.roleid WHERE m.member = r.oid ORDER BY 1)::text[] AS roles
       FROM pg_roles r WHERE r.rolname = $1`,
      [w.portalUser],
    );
    expect(rows[0]?.rolsuper).toBe(false);
    expect(rows[0]?.roles).toEqual(["pt_admin_portal"]);
  });
});

describe("audit log", () => {
  it("records authentication, changes and denials, and the chain verifies", async () => {
    const actions = new Set((await auditActions(w)).map((a) => a.action));
    for (const a of ["officer.bootstrapped", "enrol.issued", "enrol.completed", "login.success", "change.requested", "change.decided", "officer.invited", "role.granted", "role.revoked", "officer.disabled", "session.expired", "logout", "stepup.success", "login.counter_regression"]) {
      expect(actions.has(a), a).toBe(true);
    }
    expect(await verify(w)).toEqual([]);
  });

  it("a denied permission is audited by authorize()", async () => {
    const before = Number((await auditActions(w)).at(-1)?.id ?? 0);
    const { rows } = await w.portal.query<{ allowed: boolean }>("SELECT * FROM admin.authorize($1, 'officers.manage', '/officers', true)", [c.trustee_officer.sessionHash]);
    expect(rows[0]?.allowed).toBe(false);
    const after = await auditActions(w, before);
    expect(after.map((a) => a.action)).toEqual(["access.denied"]);
    expect(after[0]?.actor).toBe(c.trustee_officer.officerId);
  });

  it("cannot be changed through the table even by the owner without disabling triggers", async () => {
    expect(await code(w.su.query("UPDATE admin.audit SET actor = 'someone' WHERE id = 1"))).toBe("42501");
    expect(await code(w.su.query("DELETE FROM admin.audit WHERE id = 1"))).toBe("42501");
    expect(await code(w.su.query("TRUNCATE admin.audit"))).toBe("42501");
  });
});

// Kept last: these tamper with the scratch database.
describe("tamper detection (rogue DBA with triggers disabled)", () => {
  it("finds an edited entry, a forged credential, a swapped public key, a forged session and an edited role matrix", async () => {
    await w.su.query("ALTER TABLE admin.audit DISABLE TRIGGER audit_append_only");
    await w.su.query("UPDATE admin.audit SET detail = detail || '{\"x\":1}' WHERE id = 3");
    await w.su.query("ALTER TABLE admin.audit ENABLE TRIGGER audit_append_only");
    const forged = fakeKey();
    await w.su.query(
      "INSERT INTO admin.credentials (id, officer_id, public_key, counter, aaguid, fmt, device_type, backed_up) VALUES ($1, $2, $3, 0, gen_random_uuid(), 'none', 'singleDevice', false)",
      [forged.id, c.ops_checker.officerId, forged.publicKey],
    );
    await w.su.query("ALTER TABLE admin.credentials DISABLE TRIGGER credentials_guard");
    await w.su.query("UPDATE admin.credentials SET public_key = $2 WHERE id = $1", [c.auditor.credentialId, fakeKey().publicKey]);
    await w.su.query("ALTER TABLE admin.credentials ENABLE TRIGGER credentials_guard");
    await w.su.query("UPDATE admin.sessions SET ended_at = now(), end_reason = 'logout' WHERE officer_id = $1 AND ended_at IS NULL", [c.ops_checker.officerId]);
    await w.su.query("INSERT INTO admin.sessions (token_hash, officer_id, credential_id, created_at, expires_at) VALUES ($1, $2, $3, now(), now() + interval '8 hours')", [
      sha(token()),
      c.ops_checker.officerId,
      forged.id,
    ]);
    await w.su.query("ALTER TABLE admin.role_permissions DISABLE TRIGGER role_permissions_append_only");
    await w.su.query("INSERT INTO admin.role_permissions VALUES ('trustee_officer', 'officers.manage')");
    await w.su.query("ALTER TABLE admin.role_permissions ENABLE TRIGGER role_permissions_append_only");

    const problems = (await verify(w)).map((p) => p.problem).join("\n");
    expect(problems).toMatch(/content does not match its hash/);
    expect(problems).toContain(`credential ${forged.id.slice(0, 16)} has no matching audit entry`);
    expect(problems).toContain(`credential ${c.auditor.credentialId.slice(0, 16)} has no matching audit entry`);
    expect(problems).toMatch(/session [0-9a-f]{16} has no matching audit entry/);
    expect(problems).toMatch(/role matrix/);
  });

  it("finds a deleted entry (broken link) and a decided change edited afterwards", async () => {
    await w.su.query("ALTER TABLE admin.changes DISABLE TRIGGER changes_guard");
    await w.su.query("UPDATE admin.changes SET decision_reason = 'rewritten afterwards' WHERE status = 'approved' AND id = (SELECT min(id) FROM admin.changes WHERE status = 'approved')");
    await w.su.query("ALTER TABLE admin.changes ENABLE TRIGGER changes_guard");
    await w.su.query("ALTER TABLE admin.audit DISABLE TRIGGER audit_append_only");
    await w.su.query("DELETE FROM admin.audit WHERE id = 10");
    await w.su.query("ALTER TABLE admin.audit ENABLE TRIGGER audit_append_only");
    const problems = (await verify(w)).map((p) => p.problem).join("\n");
    expect(problems).toMatch(/prev_hash does not match/);
    expect(problems).toMatch(/was edited after it was decided/);
  });
});

