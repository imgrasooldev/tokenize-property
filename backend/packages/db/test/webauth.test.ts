import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import { adminSettings, contiguousMigrations, scratchDatabase } from "./helpers.ts";

/**
 * Migration 0024 (T-030, IP-1..IP-9): investor passkeys and database-enforced website sessions,
 * driven exactly as the website drives them (a login role that is a member of pt_web only). The
 * database cannot check WebAuthn signatures (the website does, with @simplewebauthn/server); it
 * enforces everything around them: sessions and their limits, single-use bound challenges, one
 * recorded result per ceremony, counters and clone detection, re-authentication, step-up, rate
 * limits, least privilege and a hash-chained audit.
 */
let admin: pg.Client;
let web: pg.Client;
let drop: () => Promise<void>;
const role = `pt_web_pk_${randomBytes(4).toString("hex")}`;
const password = randomBytes(24).toString("base64url");

const sha = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();
const token = (): string => randomBytes(32).toString("base64url");
const credId = (): string => randomBytes(32).toString("base64url");
const challengeText = (): string => randomBytes(32).toString("base64url");

let adminConfig: pg.ClientConfig;

beforeAll(async () => {
  let settings: pg.ClientConfig;
  ({ client: admin, settings, drop } = await scratchDatabase());
  adminConfig = settings;
  await migrate(admin, contiguousMigrations());
  await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${admin.escapeLiteral(password)}`);
  await admin.query(`GRANT pt_web TO ${role} WITH INHERIT TRUE, SET FALSE`);
  web = new pg.Client({ ...settings, user: role, password });
  await web.connect();
}, 180_000);

afterAll(async () => {
  await web.end();
  await drop();
  const root = new pg.Client(adminSettings());
  await root.connect();
  await root.query(`DROP ROLE IF EXISTS ${role}`);
  await root.end();
}, 180_000);

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? "no code";
  }
  return "ok";
}

/** An investor as sign-up creates it (optionally a demo persona, optionally created long ago). */
async function investor(opts: { persona?: "ALICE" | "BOB"; ageMinutes?: number } = {}): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO webdemo.investors (persona, display_name, wallet_address, kyc_status, created_at)
     VALUES ($1, 'Passkey Tester', $2, 'verified', now() - make_interval(mins => $3)) RETURNING id`,
    [opts.persona ?? null, `0x${randomBytes(20).toString("hex")}`, opts.ageMinutes ?? 0],
  );
  return rows[0]?.id ?? "";
}

interface Session {
  token: string;
  hash: Buffer;
}

async function signupSession(investorId: string): Promise<Session> {
  const t = token();
  const { rows } = await web.query<{ e: Date | null }>("SELECT webauth.web_start_session($1, $2, 'signup') AS e", [sha(t), investorId]);
  if (!rows[0]?.e) throw new Error("session refused");
  return { token: t, hash: sha(t) };
}

async function sessionOf(s: Session): Promise<{ investor_id: string; method: string; passkey_at: Date | null; has_passkey: boolean } | undefined> {
  const { rows } = await web.query<{ investor_id: string; method: string; passkey_at: Date | null; has_passkey: boolean }>(
    "SELECT * FROM webauth.web_session($1)",
    [s.hash],
  );
  return rows[0];
}

/** Stores and consumes a challenge, as the website does before verifying a response. */
async function ceremony(purpose: "register" | "login" | "step_up", s: Session | null): Promise<{ id: Buffer; created: string }> {
  const id = sha(token());
  const { rows } = await web.query<{ r: string }>("SELECT webauth.web_create_challenge($1, $2, $3, $4) AS r", [id, purpose, challengeText(), s?.hash ?? null]);
  const created = rows[0]?.r ?? "";
  if (created === "ok") {
    const used = await web.query<{ c: string | null }>("SELECT webauth.web_consume_challenge($1, $2, $3) AS c", [id, purpose, s?.hash ?? null]);
    if (!used.rows[0]?.c) throw new Error("challenge not consumed");
  }
  return { id, created };
}

async function addPasskey(s: Session, opts: { id?: string; uv?: boolean; name?: string; counter?: number; synced?: boolean; challenge?: Buffer } = {}): Promise<{ result: string; id: string }> {
  const id = opts.id ?? credId();
  const challenge = opts.challenge ?? (await ceremony("register", s)).id;
  const { rows } = await web.query<{ r: string }>("SELECT webauth.web_add_passkey($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) AS r", [
    challenge,
    s.hash,
    id,
    randomBytes(77),
    opts.counter ?? 0,
    ["internal", "hybrid"],
    randomUUID(),
    "none",
    opts.synced === false ? "singleDevice" : "multiDevice",
    opts.synced !== false,
    opts.uv ?? true,
    opts.name ?? "My phone",
  ]);
  return { result: rows[0]?.r ?? "", id };
}

async function login(credential: string, counter: number, opts: { uv?: boolean; challenge?: Buffer } = {}): Promise<{ investor: string | null; session: Session }> {
  const challenge = opts.challenge ?? (await ceremony("login", null)).id;
  const t = token();
  const { rows } = await web.query<{ i: string | null }>("SELECT webauth.web_login($1, $2, $3, $4, $5, false) AS i", [challenge, sha(t), credential, counter, opts.uv ?? true]);
  return { investor: rows[0]?.i ?? null, session: { token: t, hash: sha(t) } };
}

async function stepUp(s: Session, credential: string, counter: number, opts: { uv?: boolean } = {}): Promise<Date | null> {
  const c = await ceremony("step_up", s);
  if (c.created !== "ok") return null;
  const { rows } = await web.query<{ at: Date | null }>("SELECT webauth.web_step_up($1, $2, $3, $4, $5, false) AS at", [c.id, s.hash, credential, counter, opts.uv ?? true]);
  return rows[0]?.at ?? null;
}

async function status(s: Session, action: string, amountPaisa = 0n): Promise<string> {
  const { rows } = await web.query<{ r: string }>("SELECT webauth.web_step_up_status($1, $2, $3) AS r", [s.hash, action, amountPaisa.toString()]);
  return rows[0]?.r ?? "";
}

/** Test-only time travel on the scratch database: moves a session's clocks back (guard trigger off for the update). */
async function ageSession(s: Session, fields: { created?: number; passkey?: number }): Promise<void> {
  await admin.query("ALTER TABLE webauth.sessions DISABLE TRIGGER sessions_guard");
  try {
    if (fields.created !== undefined) {
      await admin.query(
        "UPDATE webauth.sessions SET created_at = created_at - make_interval(mins => $2), expires_at = expires_at - make_interval(mins => $2), last_seen_at = last_seen_at - make_interval(mins => $2) WHERE token_hash = $1",
        [s.hash, fields.created],
      );
    }
    if (fields.passkey !== undefined) {
      await admin.query("UPDATE webauth.sessions SET passkey_at = passkey_at - make_interval(mins => $2) WHERE token_hash = $1", [s.hash, fields.passkey]);
    }
  } finally {
    await admin.query("ALTER TABLE webauth.sessions ENABLE TRIGGER sessions_guard");
  }
}

async function auditActions(actor: string): Promise<string[]> {
  const { rows } = await admin.query<{ action: string }>("SELECT action FROM webauth.audit WHERE actor = $1 ORDER BY id", [actor]);
  return rows.map((r) => r.action);
}

describe("least privilege (IP-9)", () => {
  it("the website's role reaches webauth only through web_* functions", async () => {
    for (const t of ["sessions", "passkeys", "challenges", "audit", "settings", "step_up_actions"]) {
      expect(await code(web.query(`SELECT * FROM webauth.${t}`))).toBe("42501");
    }
    expect(await code(web.query("UPDATE webauth.settings SET require_passkey = false"))).toBe("42501");
    expect(await code(web.query("SELECT webauth.audit_append('x', 'forged.entry', '{}')"))).toBe("42501");
    expect(await code(web.query("SELECT webauth.start_session($1, $2, 'passkey', NULL)", [randomBytes(32), randomUUID()]))).toBe("42501");
    expect(await code(web.query("SELECT * FROM webauth.gate($1, 'offering.cancel', 0)", [randomBytes(32)]))).toBe("42501");
    expect(await code(web.query("SELECT * FROM webauth.verify_audit()"))).toBe("42501");
  });

  it("the website can no longer reserve or cancel offering units without a session (0018 wrappers revoked)", async () => {
    expect(await code(web.query("SELECT offering.web_reserve($1, $2, 'x', $3, 1, 'k', 'web:x')", [randomUUID(), randomUUID(), randomUUID()]))).toBe("42501");
    expect(await code(web.query("SELECT offering.web_cancel($1, $2, 'web:x')", [randomUUID(), randomUUID()]))).toBe("42501");
    // 0036: withdrawing only through the session-bound wrapper, which refuses without a live session.
    expect(await code(web.query("SELECT offering.web_withdraw($1, $2, 'web:x')", [randomUUID(), randomUUID()]))).toBe("42501");
    const w = await web.query<{ r: { error?: string } }>("SELECT webauth.web_withdraw($1, $2) AS r", [randomBytes(32), randomUUID()]);
    expect(w.rows[0]?.r).toEqual({ error: "session" });
    expect(await code(web.query("SELECT * FROM offering.web_disclosures($1)", [randomUUID()]))).toBe("ok");
    // The read wrappers stay available.
    expect(await code(web.query("SELECT * FROM offering.web_offerings()"))).toBe("ok");
  });
});

describe("sessions (IP-1, IP-2)", () => {
  it("persona sessions only for demo personas, sign-up sessions only for new investors", async () => {
    const alice = await investor({ persona: "ALICE" });
    const fresh = await investor();
    const old = await investor({ ageMinutes: 31 });
    const start = async (id: string, method: string) =>
      (await web.query<{ e: Date | null }>("SELECT webauth.web_start_session($1, $2, $3) AS e", [sha(token()), id, method])).rows[0]?.e ?? null;
    expect(await start(alice, "persona")).toBeInstanceOf(Date);
    expect(await start(fresh, "persona")).toBeNull();
    expect(await start(fresh, "signup")).toBeInstanceOf(Date);
    expect(await start(old, "signup")).toBeNull();
    expect(await start(fresh, "passkey")).toBeNull();
    expect(await start(randomUUID(), "signup")).toBeNull();
    expect(await auditActions(`web:${old}`)).toEqual(["session.refused"]);
  });

  it("validates on every use, ends at logout, after 30 minutes idle and after 12 hours", async () => {
    const id = await investor();
    const s = await signupSession(id);
    expect(await sessionOf(s)).toMatchObject({ investor_id: id, method: "signup", passkey_at: null, has_passkey: false });
    expect((await web.query("SELECT webauth.web_end_session($1) AS r", [s.hash])).rows[0]).toEqual({ r: true });
    expect(await sessionOf(s)).toBeUndefined();
    expect((await web.query("SELECT webauth.web_end_session($1) AS r", [s.hash])).rows[0]).toEqual({ r: false });

    const idle = await signupSession(id);
    // Created and last seen 31 minutes ago (well inside the 12 hours).
    await ageSession(idle, { created: 31 });
    expect(await sessionOf(idle)).toBeUndefined();
    const absolute = await signupSession(id);
    await ageSession(absolute, { created: 12 * 60 + 1 });
    expect(await sessionOf(absolute)).toBeUndefined();
    const { rows } = await admin.query<{ end_reason: string }>("SELECT end_reason FROM webauth.sessions WHERE token_hash = ANY($1) ORDER BY created_at", [[s.hash, idle.hash, absolute.hash]]);
    expect(rows.map((r) => r.end_reason).sort()).toEqual(["absolute", "idle", "logout"]);
    expect(await auditActions(`web:${id}`)).toEqual(expect.arrayContaining(["session.started", "logout", "session.expired"]));
  });

  it("keeps at most 10 live sessions per investor (the oldest is superseded)", async () => {
    const id = await investor();
    const sessions: Session[] = [];
    for (let i = 0; i < 11; i++) sessions.push(await signupSession(id));
    expect(await sessionOf(sessions[0] as Session)).toBeUndefined();
    expect(await sessionOf(sessions[10] as Session)).toBeDefined();
    const { rows } = await admin.query<{ n: string }>("SELECT count(*) AS n FROM webauth.sessions WHERE investor_id = $1 AND ended_at IS NULL", [id]);
    expect(rows[0]?.n).toBe("10");
  });

  it("refuses edits around the API, even by the administrator", async () => {
    const id = await investor();
    const s = await signupSession(id);
    await web.query("SELECT webauth.web_end_session($1)", [s.hash]);
    expect(await code(admin.query("UPDATE webauth.sessions SET ended_at = NULL, end_reason = NULL WHERE token_hash = $1", [s.hash]))).toBe("23514");
    expect(await code(admin.query("DELETE FROM webauth.sessions WHERE token_hash = $1", [s.hash]))).toBe("42501");
    expect(await code(admin.query("DELETE FROM webauth.audit WHERE id = (SELECT min(id) FROM webauth.audit)"))).toBe("42501");
  });
});

describe("challenges (IP-3)", () => {
  it("are single use, bound to their purpose and session, and expire", async () => {
    const id = await investor();
    const s = await signupSession(id);
    const other = await signupSession(id);
    const cid = sha(token());
    expect((await web.query("SELECT webauth.web_create_challenge($1, 'register', $2, $3) AS r", [cid, challengeText(), s.hash])).rows[0]).toEqual({ r: "ok" });
    const consume = async (purpose: string, session: Buffer | null) =>
      (await web.query<{ c: string | null }>("SELECT webauth.web_consume_challenge($1, $2, $3) AS c", [cid, purpose, session])).rows[0]?.c ?? null;
    expect(await consume("step_up", s.hash)).toBeNull();
    expect(await consume("register", other.hash)).toBeNull();
    expect(await consume("register", s.hash)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await consume("register", s.hash)).toBeNull();

    const late = sha(token());
    await web.query("SELECT webauth.web_create_challenge($1, 'login', $2, NULL)", [late, challengeText()]);
    await admin.query("UPDATE webauth.challenges SET created_at = created_at - interval '6 minutes', expires_at = expires_at - interval '6 minutes' WHERE id_hash = $1", [late]);
    expect((await web.query("SELECT webauth.web_consume_challenge($1, 'login', NULL) AS c", [late])).rows[0]).toEqual({ c: null });
    expect(await code(admin.query("UPDATE webauth.challenges SET expires_at = created_at + interval '6 minutes' WHERE id_hash = $1", [late]))).toBe("23514");
  });

  it("need a valid session for registration and step-up, and at most 5 open per session", async () => {
    const r = await web.query<{ r: string }>("SELECT webauth.web_create_challenge($1, 'register', $2, $3) AS r", [sha(token()), challengeText(), sha(token())]);
    expect(r.rows[0]?.r).toBe("session");
    const s = await signupSession(await investor());
    const results: string[] = [];
    for (let i = 0; i < 6; i++) {
      results.push((await web.query<{ r: string }>("SELECT webauth.web_create_challenge($1, 'register', $2, $3) AS r", [sha(token()), challengeText(), s.hash])).rows[0]?.r ?? "");
    }
    expect(results).toEqual(["ok", "ok", "ok", "ok", "ok", "busy"]);
    // Step-up without any passkey: nothing to step up with.
    expect((await web.query<{ r: string }>("SELECT webauth.web_create_challenge($1, 'step_up', $2, $3) AS r", [sha(token()), challengeText(), (await signupSession(await investor())).hash])).rows[0]?.r).toBe("none");
  });
});

describe("passkey registration (IP-4, IP-5)", () => {
  it("first passkey on a fresh session; a later one only after a passkey step-up", async () => {
    const id = await investor();
    const s = await signupSession(id);
    const first = await addPasskey(s, { name: "Laptop" });
    expect(first.result).toBe("ok");
    // A second passkey needs a passkey assertion on this session first.
    expect((await ceremony("register", s)).created).toBe("reauth");
    expect(await stepUp(s, first.id, 0)).toBeInstanceOf(Date);
    expect((await addPasskey(s, { name: "Phone" })).result).toBe("ok");
    const { rows } = await web.query("SELECT * FROM webauth.web_passkeys($1)", [s.hash]);
    expect(rows.map((r: { name: string }) => r.name)).toEqual(["Laptop", "Phone"]);
    // Labels, kind and times only: no credential ID, public key or counter.
    expect(Object.keys(rows[0] as object).sort()).toEqual(["created_at", "last_used_at", "name", "ref", "synced", "this_session"]);
    expect(await auditActions(`web:${id}`)).toEqual(expect.arrayContaining(["passkey.registered", "register.reauth_required", "stepup.success"]));
  });

  it("an older session must sign in again before adding the first passkey", async () => {
    const s = await signupSession(await investor());
    await ageSession(s, { created: 11 });
    expect((await ceremony("register", s)).created).toBe("reauth");
  });

  it("refuses without a consumed ceremony, without user verification, bad labels, duplicates and an 11th passkey", async () => {
    const s = await signupSession(await investor());
    // A challenge that was created but never consumed (no verified response) cannot record anything.
    const unconsumed = sha(token());
    await web.query("SELECT webauth.web_create_challenge($1, 'register', $2, $3)", [unconsumed, challengeText(), s.hash]);
    expect((await addPasskey(s, { challenge: unconsumed })).result).toBe("ceremony");
    expect((await addPasskey(s, { uv: false })).result).toBe("uv");
    for (const name of ["", " padded", "x".repeat(41), "<script>", "CNIC 3520212345671"]) {
      expect((await addPasskey(s, { name })).result).toBe("name");
    }
    const ok = await addPasskey(s, { name: "میرا فون" });
    expect(ok.result).toBe("ok");
    // The same credential for another investor (or again) is refused.
    const thief = await signupSession(await investor());
    expect((await addPasskey(thief, { id: ok.id })).result).toBe("duplicate");
    // A recorded ceremony is used once.
    const c = await ceremony("register", thief);
    expect((await addPasskey(thief, { challenge: c.id })).result).toBe("ok");
    expect((await addPasskey(thief, { challenge: c.id })).result).toBe("ceremony");
  });

  it("keeps at most 10 active passkeys", async () => {
    const id = await investor();
    const s = await signupSession(id);
    const first = await addPasskey(s);
    let counter = 0;
    for (let i = 0; i < 9; i++) {
      await stepUp(s, first.id, 0);
      expect((await addPasskey(s, { counter: ++counter })).result).toBe("ok");
    }
    await stepUp(s, first.id, 0);
    expect((await ceremony("register", s)).created).toBe("limit");
  });

  it("passkeys are never deleted; only counter, backup state, last use and revoking change", async () => {
    const s = await signupSession(await investor());
    const p = await addPasskey(s, { synced: false, counter: 5 });
    expect(await code(admin.query("DELETE FROM webauth.passkeys WHERE id = $1", [p.id]))).toBe("42501");
    expect(await code(admin.query("UPDATE webauth.passkeys SET public_key = $2 WHERE id = $1", [p.id, randomBytes(77)]))).toBe("23514");
    expect(await code(admin.query("UPDATE webauth.passkeys SET counter = 1 WHERE id = $1", [p.id]))).toBe("23514");
    expect(await code(admin.query("UPDATE webauth.passkeys SET investor_id = $2 WHERE id = $1", [p.id, await investor()]))).toBe("23514");
  });
});

describe("sign-in with a passkey (IP-2, IP-3, IP-4)", () => {
  it("starts a passkey session once per ceremony; replay, missing user verification and unknown keys fail", async () => {
    const id = await investor();
    const p = await addPasskey(await signupSession(id), { synced: false, counter: 1 });
    const c = await ceremony("login", null);
    const first = await login(p.id, 2, { challenge: c.id });
    expect(first.investor).toBe(id);
    expect(await sessionOf(first.session)).toMatchObject({ investor_id: id, method: "passkey", has_passkey: true });
    expect((await sessionOf(first.session))?.passkey_at).toBeInstanceOf(Date);
    // The same ceremony again (a replayed response): refused.
    expect((await login(p.id, 3, { challenge: c.id })).investor).toBeNull();
    expect((await login(p.id, 3, { uv: false })).investor).toBeNull();
    expect((await login(credId(), 1)).investor).toBeNull();
    expect((await login(p.id, 3)).investor).toBe(id);
    expect(await auditActions(`web:${id}`)).toEqual(expect.arrayContaining(["login.success", "login.failed"]));
  });

  it("detects a cloned authenticator: the passkey is revoked, its sessions end and an alert is raised", async () => {
    const id = await investor();
    const p = await addPasskey(await signupSession(id), { synced: false, counter: 10 });
    const live = await login(p.id, 11);
    expect(live.investor).toBe(id);
    const listener = new pg.Client(adminConfig);
    await listener.connect();
    const alerts: string[] = [];
    listener.on("notification", (n) => alerts.push(n.payload ?? ""));
    await listener.query("LISTEN webauth_alert");
    try {
      expect((await login(p.id, 11)).investor).toBeNull();
      await new Promise((r) => setTimeout(r, 300));
      expect(alerts.length).toBe(1);
      expect(JSON.parse(alerts[0] ?? "{}")).toMatchObject({ alert: "counter_regression", investor: id });
    } finally {
      await listener.end();
    }
    expect(await sessionOf(live.session)).toBeUndefined();
    const { rows } = await admin.query<{ revoked_reason: string }>("SELECT revoked_reason FROM webauth.passkeys WHERE id = $1", [p.id]);
    expect(rows[0]?.revoked_reason).toBe("clone_suspected");
    expect((await login(p.id, 99)).investor).toBeNull();
  });

  it("synced passkeys that report no counter (always 0) keep working", async () => {
    const id = await investor();
    const p = await addPasskey(await signupSession(id), { counter: 0 });
    expect((await login(p.id, 0)).investor).toBe(id);
    expect((await login(p.id, 0)).investor).toBe(id);
  });

  it("locks an investor's passkey ceremonies after 10 failures in 15 minutes (IP-7)", async () => {
    const id = await investor();
    const s = await signupSession(id);
    const p = await addPasskey(s);
    for (let i = 0; i < 10; i++) await web.query("SELECT webauth.web_auth_failed('login', 'bad signature', $1, NULL)", [p.id]);
    expect((await login(p.id, 0)).investor).toBeNull();
    expect((await ceremony("step_up", s)).created).toBe("locked");
    expect(await auditActions(`web:${id}`)).toEqual(expect.arrayContaining(["login.locked", "ceremony.locked"]));
    // Unknown kinds are refused.
    expect(await code(web.query("SELECT webauth.web_auth_failed('other', 'x', NULL, NULL)"))).toBe("22023");
  });
});

describe("step-up for sensitive actions (IP-6) and revocation (IP-5)", () => {
  it("without a passkey: waived while passkeys are optional, refused once they are required", async () => {
    const s = await signupSession(await investor());
    expect(await status(s, "offering.cancel")).toBe("waived");
    expect(await status(s, "offering.reserve", 100n)).toBe("ok");
    await admin.query("UPDATE webauth.settings SET require_passkey = true");
    try {
      expect(await status(s, "offering.cancel")).toBe("enrol");
    } finally {
      await admin.query("UPDATE webauth.settings SET require_passkey = false");
    }
    const { rows } = await admin.query<{ actor: string; detail: { op: string } }>("SELECT actor, detail FROM webauth.audit WHERE action = 'settings.changed' AND detail->>'table' = 'settings' ORDER BY id");
    expect(rows.length).toBe(2);
    expect(rows[0]?.actor).toMatch(/^db:/);
    expect(await status({ token: "", hash: sha(token()) }, "offering.cancel")).toBe("session");
  });

  it("with a passkey: an assertion on this session within 5 minutes, above the threshold, deny by default", async () => {
    const id = await investor();
    const s = await signupSession(id);
    const p = await addPasskey(s);
    expect(await status(s, "offering.cancel")).toBe("step_up");
    expect(await status(s, "offering.reserve", 9_999_999n)).toBe("ok");
    expect(await status(s, "offering.reserve", 10_000_000n)).toBe("step_up");
    expect(await status(s, "bank.payout_account")).toBe("step_up");
    expect(await stepUp(s, p.id, 0)).toBeInstanceOf(Date);
    expect(await status(s, "offering.cancel")).toBe("ok");
    expect(await status(s, "offering.reserve", 10n ** 15n)).toBe("ok");
    // An action nobody listed always needs a step-up (and with one, passes).
    expect(await status(s, "account.unknown_action")).toBe("ok");
    await ageSession(s, { passkey: 6 });
    expect(await status(s, "offering.cancel")).toBe("step_up");
    expect(await status(s, "account.unknown_action")).toBe("step_up");
    // The audited gate records the refusal.
    expect((await web.query("SELECT webauth.web_require_recent_passkey($1, 'offering.cancel', 0) AS r", [s.hash])).rows[0]).toEqual({ r: "step_up" });
    expect(await auditActions(`web:${id}`)).toContain("stepup.required");
  });

  it("a step-up must use the investor's own, active passkey with user verification", async () => {
    const a = await signupSession(await investor());
    const b = await signupSession(await investor());
    const pa = await addPasskey(a);
    const pb = await addPasskey(b);
    expect(await stepUp(a, pb.id, 0)).toBeNull();
    expect(await stepUp(a, pa.id, 0, { uv: false })).toBeNull();
    expect(await stepUp(a, pa.id, 0)).toBeInstanceOf(Date);
  });

  it("revoking needs a recent passkey and ends the other sessions signed in with it", async () => {
    const id = await investor();
    const s = await signupSession(id);
    const p = await addPasskey(s, { name: "Old phone" });
    const other = await login(p.id, 0);
    const keep = await addPasskey(s, { name: "New phone", challenge: (await (async () => {
      await stepUp(s, p.id, 0);
      return ceremony("register", s);
    })()).id });
    expect(keep.result).toBe("ok");
    const refs = (await web.query<{ ref: string; name: string }>("SELECT ref, name FROM webauth.web_passkeys($1)", [s.hash])).rows;
    const oldRef = refs.find((r) => r.name === "Old phone")?.ref ?? "";
    await ageSession(s, { passkey: 6 });
    expect((await web.query("SELECT webauth.web_revoke_passkey($1, $2) AS r", [s.hash, oldRef])).rows[0]).toEqual({ r: "step_up" });
    // Another investor's passkey reference is unknown to this session.
    const stranger = await signupSession(await investor());
    expect((await web.query("SELECT webauth.web_revoke_passkey($1, $2) AS r", [stranger.hash, oldRef])).rows[0]).toEqual({ r: "unknown" });
    await stepUp(s, keep.id, 0);
    expect((await web.query("SELECT webauth.web_revoke_passkey($1, $2) AS r", [s.hash, oldRef])).rows[0]).toEqual({ r: "ok" });
    expect(await sessionOf(other.session)).toBeUndefined();
    expect(await sessionOf(s)).toBeDefined();
    expect((await login(p.id, 0)).investor).toBeNull();
    expect((await web.query("SELECT name FROM webauth.web_passkeys($1)", [s.hash])).rows).toEqual([{ name: "New phone" }]);
  });
});

describe("audit (IP-8)", () => {
  it("verifies, and finds edits and rows written around the API", async () => {
    expect((await admin.query("SELECT * FROM webauth.verify_audit()")).rows).toEqual([]);
    const id = await investor();
    // A passkey inserted directly by a database administrator (no registration ceremony, no audit entry).
    await admin.query(
      "INSERT INTO webauth.passkeys (id, investor_id, name, public_key, counter, aaguid, fmt, device_type, backed_up) VALUES ($1, $2, 'Planted', $3, 0, $4, 'none', 'multiDevice', true)",
      [credId(), id, randomBytes(77), randomUUID()],
    );
    const problems = (await admin.query<{ problem: string }>("SELECT problem FROM webauth.verify_audit()")).rows.map((r) => r.problem);
    expect(problems.some((p) => /^passkey .* has no matching audit entry$/.test(p))).toBe(true);
    // An edited audit row (trigger disabled by a superuser) breaks the chain.
    await admin.query("ALTER TABLE webauth.audit DISABLE TRIGGER audit_append_only");
    try {
      await admin.query("UPDATE webauth.audit SET detail = '{\"edited\": true}' WHERE id = (SELECT min(id) FROM webauth.audit)");
    } finally {
      await admin.query("ALTER TABLE webauth.audit ENABLE TRIGGER audit_append_only");
    }
    const after = (await admin.query<{ problem: string }>("SELECT problem FROM webauth.verify_audit()")).rows.map((r) => r.problem);
    expect(after).toContain("content does not match its hash");
  });
});
