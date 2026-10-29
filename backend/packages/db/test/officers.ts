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

/**
 * Step 6d (migration 0023): the trustee's co-signature on a signing request, given the way the
 * portal gives it: a signed-in trustee officer (fresh step-up) obtains a one-time ticket of capacity
 * "trustee" and the ticket is redeemed through signer.decide_officer (the signing service's call).
 * The call hash is a stand-in here (the service's recomputation is tested in signer/test). Returns
 * the request's status after the decision.
 */
export async function trusteeCosign(
  db: pg.ClientBase,
  requestId: string,
  opts: { handle?: string; decision?: "approve" | "reject"; reason?: string } = {},
): Promise<string> {
  const handle = opts.handle ?? "trustee.test.one";
  const decision = opts.decision ?? "approve";
  const reason = opts.reason ?? "trustee co-signature: register and subscription checked";
  const o = await officer(db, handle, "trustee_officer");
  const req = await db.query<{ payload_hash: Buffer }>("SELECT payload_hash FROM signer.requests WHERE id = $1", [requestId]);
  const payloadHash = req.rows[0]?.payload_hash;
  if (!payloadHash) throw new Error(`unknown signing request ${requestId}`);
  const ticket = tok();
  const call = randomBytes(32);
  const issued = await db.query<{ r: { ok: boolean; error?: string } }>("SELECT admin.issue_trustee_ticket($1, $2, $3, $4, $5, $6, $7) AS r", [
    o.sessionHash,
    requestId,
    decision,
    reason,
    payloadHash,
    call,
    sha(ticket),
  ]);
  if (!issued.rows[0]?.r.ok) throw new Error(`trustee ticket refused: ${issued.rows[0]?.r.error ?? "?"}`);
  const out = await db.query<{ s: string }>("SELECT signer.decide_officer($1, $2, $3, $4, $5) AS s", [sha(ticket), requestId, decision, reason, call]);
  return out.rows[0]?.s ?? "";
}

/** The answer of an admin.* decision function (0016 refusals are returned; 0026 adds the SQLSTATE). */
export interface PortalResult {
  ok: boolean;
  status?: string;
  error?: string;
  /** SQLSTATE of the backend's refusal (migration 0026): 23514 guard, 23505 duplicate, 42501 forbidden, 22023 input. */
  state?: string;
  meeting?: number;
  /** Migration 0045: the id of a new S-01 request. */
  id?: number;
  vote?: number;
}

async function portalCall(db: pg.ClientBase, sql: string, params: unknown[]): Promise<PortalResult> {
  const { rows } = await db.query<{ r: PortalResult | null }>(sql, params);
  const r = rows[0]?.r;
  if (!r) throw new Error("no answer from the portal function");
  return r;
}

async function portalRead<T>(db: pg.ClientBase, sql: string, params: unknown[]): Promise<T> {
  const { rows } = await db.query<{ v: T | null }>(sql, params);
  const v = rows[0]?.v;
  if (!v) throw new Error("not found in the portal");
  return v;
}

const DEFAULT_REASON = "reviewed the file in PT Control, agree with the outcome";

/**
 * Migration 0026 (T-046): investment-committee and P8 votes and platform votes on S-02 requests,
 * cast the way PT Control casts them: the officer signs in (a fresh step-up), reads the item through
 * the portal's own function (the digest of what is shown) and decides through the admin.* function,
 * which runs the backend function under the officer's handle. A missing committee or offering
 * officer is created as an operations checker; existing officers are only signed in again.
 */
export async function committeeOpen(db: pg.ClientBase, chair: string, propertyId: string, reason = "the file is complete and ready for the committee"): Promise<PortalResult> {
  const o = await officer(db, chair, "ops_checker");
  return portalCall(db, "SELECT admin.open_committee($1, $2, $3) AS r", [o.sessionHash, propertyId, reason]);
}

/**
 * Migration 0045: an S-01 maker-checker request (K4, K5, K10, K11, SC, P6, P13, P14) asked by an
 * officer in the portal (session, fresh step-up; the duty rules still decide).
 */
export async function propertyRequest(
  db: pg.ClientBase,
  handle: string,
  r: { entity: "sponsor" | "property"; id: string; code: string; reason: string; detail?: Record<string, unknown> },
): Promise<PortalResult> {
  const o = await officer(db, handle, "compliance_officer");
  return portalCall(db, "SELECT admin.request_property_transition($1, $2, $3, $4, $5, $6::jsonb) AS r", [
    o.sessionHash,
    r.entity,
    r.id,
    r.code,
    r.reason,
    JSON.stringify(r.detail ?? {}),
  ]);
}

export async function committeeVote(
  db: pg.ClientBase,
  member: string,
  meetingId: string,
  vote: "approve" | "reject" | "abstain" | "conflict",
  reason = DEFAULT_REASON,
): Promise<PortalResult> {
  const o = await officer(db, member, "ops_checker");
  const m = await portalRead<{ digest: string }>(db, "SELECT admin.committee($1, $2) AS v", [o.sessionHash, meetingId]);
  return portalCall(db, "SELECT admin.committee_vote($1, $2, $3, $4, $5) AS r", [o.sessionHash, meetingId, vote, reason, Buffer.from(m.digest, "hex")]);
}

export async function committeeClose(db: pg.ClientBase, chair: string, meetingId: string, minutesSha256: string, reason = "votes counted, minutes signed and filed"): Promise<PortalResult> {
  const o = await officer(db, chair, "ops_checker");
  const m = await portalRead<{ closeDigest: string }>(db, "SELECT admin.committee($1, $2) AS v", [o.sessionHash, meetingId]);
  return portalCall(db, "SELECT admin.close_committee($1, $2, $3, $4, $5) AS r", [o.sessionHash, meetingId, minutesSha256, reason, Buffer.from(m.closeDigest, "hex")]);
}

/** The trustee's P8 decision on the latest structure of a property. */
export async function trusteePropertyDecision(
  db: pg.ClientBase,
  trustee: string,
  propertyId: string,
  decision: "accept" | "decline",
  opts: { reason?: string; conditions?: string; structureId?: string } = {},
): Promise<PortalResult> {
  const o = await officer(db, trustee, "trustee_officer");
  const p = await portalRead<{ digest: string; structure: { id: number } | null }>(db, "SELECT admin.trustee_property($1, $2) AS v", [o.sessionHash, propertyId]);
  return portalCall(db, "SELECT admin.decide_property_trustee($1, $2, $3, $4, $5, $6, $7) AS r", [
    o.sessionHash,
    propertyId,
    opts.structureId ?? String(p.structure?.id ?? 0),
    decision,
    opts.conditions ?? null,
    opts.reason ?? "trust deed, structure and register size accepted",
    Buffer.from(p.digest, "hex"),
  ]);
}

/** A platform officer's vote on an S-02 request (Operations > Offering approvals). */
export async function offeringVote(db: pg.ClientBase, handle: string, requestId: string, decision: "approve" | "reject", reason = DEFAULT_REASON): Promise<PortalResult> {
  const o = await officer(db, handle, "ops_checker");
  const q = await portalRead<{ digest: string }>(db, "SELECT admin.offering_vote_request($1, $2) AS v", [o.sessionHash, requestId]);
  return portalCall(db, "SELECT admin.vote_offering_request($1, $2, $3, $4, $5) AS r", [o.sessionHash, requestId, decision, reason, Buffer.from(q.digest, "hex")]);
}

/** The trustee's vote on an S-02 request (Trustee > Co-signing, migration 0023). */
export async function offeringTrusteeVote(db: pg.ClientBase, handle: string, requestId: string, decision: "approve" | "reject", reason = DEFAULT_REASON): Promise<PortalResult> {
  const o = await officer(db, handle, "trustee_officer");
  const q = await portalRead<{ digest: string }>(db, "SELECT admin.trustee_offering_request($1, $2) AS v", [o.sessionHash, requestId]);
  return portalCall(db, "SELECT admin.decide_offering_request($1, $2, $3, $4, $5) AS r", [o.sessionHash, requestId, decision, reason, Buffer.from(q.digest, "hex")]);
}
