import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";

/**
 * Officers of the admin portal for backend tests (migration 0013 + 0016), created the way production
 * does it: two bootstrap administrators, then maker-checker invitations, one-time enrolment links and
 * enrolment; sign-in starts a session that counts as a fresh step-up. The WebAuthn signature check
 * runs in the portal, so a stand-in public key is enough here. Needs a superuser client on a
 * scratch database.
 */
export interface TestOfficer {
  id: string;
  handle: string;
  credentialId: string;
  /** SHA-256 of the session token, as the portal passes it to every admin.* function. */
  sessionHash: Buffer;
}

const sha = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();
const tok = (): string => randomBytes(32).toString("base64url");
// Signature counters must move forward across every sign-in of a key.
let counter = Date.now();

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const admins = new WeakMap<pg.ClientBase, [TestOfficer, TestOfficer]>();

function displayName(handle: string): string {
  const letters = handle.replace(/[^a-z]+/g, " ").trim();
  return `Test ${letters || "Officer"}`.slice(0, 80);
}

async function enrol(db: pg.ClientBase, link: string): Promise<{ id: string; credentialId: string }> {
  const credentialId = randomBytes(20).toString("base64url");
  const { rows } = await db.query<{ id: string | null }>("SELECT admin.complete_enrolment($1, $2, $3, 0, '{usb}', $4, 'packed', 'singleDevice', false, true) AS id", [
    sha(link),
    credentialId,
    randomBytes(77),
    ZERO_UUID,
  ]);
  const id = rows[0]?.id;
  if (!id) throw new Error("test enrolment refused");
  return { id, credentialId };
}

/** Signs an officer in again: a new session whose step-up is fresh (the login itself). */
export async function signIn(db: pg.ClientBase, o: Pick<TestOfficer, "id" | "handle" | "credentialId">): Promise<TestOfficer> {
  const t = tok();
  const { rows } = await db.query<{ id: string | null }>("SELECT admin.start_session($1, $2, $3) AS id", [sha(t), o.credentialId, ++counter]);
  if (!rows[0]?.id) throw new Error(`test sign-in refused for ${o.handle}`);
  return { ...o, sessionHash: sha(t) };
}

/** The two bootstrap administrators, signed in (created on first use). */
export async function bootstrapAdmins(db: pg.ClientBase): Promise<[TestOfficer, TestOfficer]> {
  const known = admins.get(db);
  if (known) return [await signIn(db, known[0]), await signIn(db, known[1])];
  const made: TestOfficer[] = [];
  for (const handle of ["test.admin.a", "test.admin.b"]) {
    const link = tok();
    await db.query("SELECT admin.bootstrap_admin($1, $2, $3, 'test:bootstrap')", [handle, displayName(handle), sha(link)]);
    const e = await enrol(db, link);
    made.push(await signIn(db, { id: e.id, handle, credentialId: e.credentialId }));
  }
  const pair = made as [TestOfficer, TestOfficer];
  admins.set(db, pair);
  return pair;
}

/**
 * An active officer with this handle holding `role` (invited by one administrator, approved by the
 * other, enrolled), signed in. If the officer already exists it is only signed in again.
 */
export async function officer(db: pg.ClientBase, handle: string, role: string): Promise<TestOfficer> {
  const existing = await db.query<{ id: string; credential: string | null }>(
    "SELECT o.id, (SELECT c.id FROM admin.credentials c WHERE c.officer_id = o.id LIMIT 1) AS credential FROM admin.officers o WHERE o.handle = $1",
    [handle],
  );
  const row = existing.rows[0];
  if (row?.credential) return signIn(db, { id: row.id, handle, credentialId: row.credential });
  const [a, b] = await bootstrapAdmins(db);
  const { rows } = await db.query<{ id: string }>("SELECT admin.request_change($1, 'invite', NULL, $2, $3, $4, 'test officer for the backend tests') AS id", [
    a.sessionHash,
    role,
    handle,
    displayName(handle),
  ]);
  await db.query("SELECT admin.decide_change($1, $2, 'approve', 'approved for the backend tests')", [b.sessionHash, rows[0]?.id]);
  const link = tok();
  await db.query("SELECT admin.issue_enrolment($1, $2, 'test:link', 30)", [handle, sha(link)]);
  const e = await enrol(db, link);
  return signIn(db, { id: e.id, handle, credentialId: e.credentialId });
}

/** An officer change requested by one administrator and approved by the other (maker-checker). */
export async function changeOfficer(db: pg.ClientBase, kind: "grant" | "revoke" | "disable", officerId: string, role: string | null): Promise<void> {
  const [a, b] = await bootstrapAdmins(db);
  const { rows } = await db.query<{ id: string }>("SELECT admin.request_change($1, $2, $3, $4, NULL, NULL, 'officer change for the backend tests') AS id", [
    a.sessionHash,
    kind,
    officerId,
    role,
  ]);
  await db.query("SELECT admin.decide_change($1, $2, 'approve', 'approved for the backend tests')", [b.sessionHash, rows[0]?.id]);
}

/** The portal roles that may hold an S-01 duty (admin.duty_roles); the first is used for new officers. */
const DUTY_ROLE: Record<string, string> = {
  onboarding: "ops_maker",
  compliance: "compliance_officer",
  compliance_senior: "compliance_officer",
  trustee: "trustee_officer",
};

/** An officer able to hold this S-01 duty (an existing officer with a compatible role is kept). */
export async function officerForDuty(db: pg.ClientBase, handle: string, duty: string): Promise<void> {
  const { rows } = await db.query<{ ok: boolean; exists: boolean }>(
    "SELECT admin.officer_holds($1, admin.duty_roles($2), false) AS ok, EXISTS (SELECT 1 FROM admin.officers WHERE handle = $1) AS exists",
    [handle, duty],
  );
  if (rows[0]?.ok) return;
  if (rows[0]?.exists) throw new Error(`test officer ${handle} exists without a role for the ${duty} duty`);
  await officer(db, handle, new Map(Object.entries(DUTY_ROLE)).get(duty) ?? "ops_checker");
}
