import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SoftAuthenticator } from "./authenticator";

/**
 * Investor passkeys end to end through the website's server actions (T-030, migration 0024): a
 * software authenticator produces real WebAuthn responses, @simplewebauthn/server verifies them,
 * and the database (the backend's offering test world, a throw-away database at the latest
 * migration, reached through the website's own role pt_web_app) records sessions, passkeys and
 * step-ups. Covers registration, discoverable sign-in, forged/replayed/cross-origin responses,
 * clone detection, step-up for reserve (threshold) and cancel, revocation, logout, and the
 * "passkeys unavailable" cases (plain-HTTP IP origin, wrong host).
 *
 * Next's request APIs are replaced by a cookie jar and adjustable headers; redirect() throws.
 */
const jar = vi.hoisted(() => new Map<string, string>());
// Each test signs in from its own client address (TRUST_PROXY=1 below), so the per-address
// sign-in rate limit (10 a minute) is exercised on purpose only in its own test.
const requestHeaders = vi.hoisted(() => ({ host: "localhost:3100", xff: "10.0.0.1" }));
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
      set: (name: string, value: string, opts?: { maxAge?: number }) => {
        if (opts?.maxAge === 0) jar.delete(name);
        else jar.set(name, value);
      },
      delete: (name: string) => {
        jar.delete(name);
      },
    }),
  headers: () => Promise.resolve(new Headers({ "user-agent": "vitest", host: requestHeaders.host, "x-forwarded-for": requestHeaders.xff })),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const ORIGIN = "http://localhost:3100";

interface Investor {
  subjectId: string;
  wallet: string;
}
interface World {
  client: pg.Client;
  settings: { database?: string };
  drop(): Promise<void>;
}
interface WorldModule {
  makeWorld(): Promise<World>;
  liveOffering(w: World, o: { cap: bigint; maxUnits: bigint; price: bigint }): Promise<{ id: string; d: unknown; docs: { en: string; ur: string; risk: string }; price: bigint }>;
  investor(w: World, d: unknown): Promise<Investor>;
}

process.env.WEB_SESSION_SECRET ??= Buffer.alloc(32, 7).toString("base64url");
process.env.TRUST_PROXY = "1";
let nextAddress = 1;

type PasskeyActions = typeof import("../src/app/actions/passkey");
type OfferingActions = typeof import("../src/app/actions/offering");
type Session = typeof import("../src/lib/server/session");
let pk: PasskeyActions;
let offering: OfferingActions;
let session: Session;
let dbm: typeof import("../src/lib/server/db") | undefined;
let m: WorldModule;
let w: World;
let o: Awaited<ReturnType<WorldModule["liveOffering"]>>;
let built = false;

async function redirectOf(p: Promise<unknown>): Promise<string> {
  try {
    const r = await p;
    return `returned ${JSON.stringify(r)}`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.startsWith("REDIRECT ")) throw e;
    return msg.slice("REDIRECT ".length);
  }
}

/** A KYC-verified investor of the backend world with a website record. */
async function newInvestor(name: string): Promise<{ id: string; subject: string }> {
  const inv = await m.investor(w, o.d);
  const { rows } = await w.client.query<{ id: string }>(
    "INSERT INTO webdemo.investors (display_name, wallet_address, kyc_status, kyc_subject, onboard_step) VALUES ($1, $2, 'verified', $3, 'done') RETURNING id",
    [name, inv.wallet, inv.subjectId],
  );
  return { id: rows[0]?.id ?? "", subject: inv.subjectId };
}

async function signUpSession(id: string): Promise<void> {
  jar.clear();
  await session.startSession(id, "signup");
}

async function register(auth: SoftAuthenticator, name: string, tamper = {}): Promise<unknown> {
  const o1 = await pk.passkeyRegisterOptions(name);
  if ("error" in o1) return o1;
  return pk.passkeyRegisterVerify(auth.register(o1.options, tamper), name);
}

async function signIn(auth: SoftAuthenticator, tamper = {}): Promise<unknown> {
  jar.clear();
  requestHeaders.xff = `10.0.1.${String(++nextAddress)}`;
  const o1 = await pk.passkeyLoginOptions();
  if ("error" in o1) return o1;
  return pk.passkeyLoginVerify(auth.authenticate(o1.options, tamper));
}

async function stepUp(auth: SoftAuthenticator, tamper = {}): Promise<unknown> {
  const o1 = await pk.passkeyStepUpOptions();
  if ("error" in o1) return o1;
  return pk.passkeyStepUpVerify(auth.authenticate(o1.options, tamper));
}

async function audit(investorId: string): Promise<string[]> {
  const { rows } = await w.client.query<{ action: string }>("SELECT action FROM webauth.audit WHERE actor = $1 ORDER BY id", [`web:${investorId}`]);
  return rows.map((r) => r.action);
}

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const reserveForm = (units: string, requestId = randomUUID()) =>
  form({ offeringId: o.id, units, requestId, language: "en", docSha: o.docs.en, riskSha: o.docs.risk, acceptDoc: "on", acceptRisk: "on" });

async function databaseReady(): Promise<boolean> {
  const backend = join(import.meta.dirname, "..", "..", "backend");
  const envFile = join(backend, ".env.local");
  if (!existsSync(join(backend, "node_modules", "@pt", "bank")) || !existsSync(envFile)) return false;
  const env = readFileSync(envFile, "utf8");
  if (!/^WEB_PG_USER=/m.test(env) || !/^WEB_PG_PASSWORD=/m.test(env)) return false;
  const port = Number(/^PG_PORT=(\d+)/m.exec(env)?.[1] ?? 5433);
  return new Promise((resolve) => {
    const s = connect({ host: "127.0.0.1", port }, () => {
      s.end();
      resolve(true);
    });
    s.on("error", () => {
      resolve(false);
    });
    s.setTimeout(2_000, () => {
      s.destroy();
      resolve(false);
    });
  });
}
const ready = await databaseReady();

describe.skipIf(!ready)("investor passkeys against PostgreSQL (T-030)", () => {
  beforeAll(async () => {
    const url = pathToFileURL(join(import.meta.dirname, "..", "..", "backend", "packages", "offering", "test", "world.ts")).href;
    m = (await import(/* @vite-ignore */ url)) as WorldModule;
    w = await m.makeWorld();
    built = true;
    const name = w.settings.database ?? "";
    if (!/^pt_scratch_/.test(name)) throw new Error("expected a scratch database");
    process.env.WEB_DB_NAME = name;
    // PKR 5,000 a unit: 10 units are under the PKR 100,000 step-up threshold, 20 units reach it.
    o = await m.liveOffering(w, { cap: 200n, maxUnits: 50n, price: 500_000n });
    pk = await import("../src/app/actions/passkey");
    offering = await import("../src/app/actions/offering");
    session = await import("../src/lib/server/session");
    dbm = await import("../src/lib/server/db");
  }, 300_000);

  afterAll(async () => {
    if (dbm) await (await dbm.db()).end();
    if (built) await w.drop();
  }, 120_000);

  beforeEach(() => {
    requestHeaders.xff = `10.0.0.${String(++nextAddress)}`;
  });

  it("limits passkey sign-in attempts per client address", async () => {
    const results: string[] = [];
    for (let i = 0; i < 11; i++) {
      jar.clear();
      const r = await pk.passkeyLoginOptions();
      results.push("error" in r ? r.error : "ok");
    }
    expect(results.slice(0, 10).every((r) => r === "ok")).toBe(true);
    expect(results[10]).toBe("rate");
  });

  it("is unavailable on the plain-HTTP IP demo and on another host, and says so", async () => {
    const before = process.env.WEB_ORIGIN;
    process.env.WEB_ORIGIN = "http://51.79.144.40";
    try {
      expect(await pk.passkeyLoginOptions()).toEqual({ error: "unavailable" });
    } finally {
      if (before === undefined) delete process.env.WEB_ORIGIN;
      else process.env.WEB_ORIGIN = before;
    }
    requestHeaders.host = "127.0.0.1:3100";
    try {
      expect(await pk.passkeyLoginOptions()).toEqual({ error: "unavailable" });
    } finally {
      requestHeaders.host = "localhost:3100";
    }
  });

  it("registers a passkey from a fresh session and lists it without credential data", async () => {
    const inv = await newInvestor("Sana Passkey");
    await signUpSession(inv.id);
    const auth = new SoftAuthenticator(ORIGIN, { synced: true });
    expect(await register(auth, "My phone")).toEqual({ ok: true });
    const s = await session.currentSession();
    expect(s?.hasPasskey).toBe(true);
    const { listPasskeys } = await import("../src/lib/server/passkeys");
    const list = await listPasskeys(s?.hash ?? Buffer.alloc(0), "en");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "My phone", synced: true, lastUsed: null });
    expect(JSON.stringify(list)).not.toContain(auth.creds[0]?.id.toString("base64url") ?? "-");
    expect(await audit(inv.id)).toEqual(["session.started", "passkey.registered"]);
  });

  it("refuses a registration from another origin, a replayed response and a second passkey without step-up", async () => {
    const inv = await newInvestor("Omar Origin");
    await signUpSession(inv.id);
    const auth = new SoftAuthenticator(ORIGIN);
    expect(await register(auth, "Phishing site", { origin: "http://evil.localhost:3100" })).toEqual({ error: "verify" });
    const o1 = await pk.passkeyRegisterOptions("Laptop");
    if ("error" in o1) throw new Error(o1.error);
    const response = auth.register(o1.options);
    expect(await pk.passkeyRegisterVerify(response, "Laptop")).toEqual({ ok: true });
    // The same response again: the ceremony is gone.
    expect(await pk.passkeyRegisterVerify(response, "Laptop")).toEqual({ error: "expired" });
    // A second passkey needs a confirmation with the first one.
    expect(await pk.passkeyRegisterOptions("Tablet")).toEqual({ error: "reauthStepUp" });
    expect(await stepUp(auth)).toEqual({ ok: true });
    expect(await register(new SoftAuthenticator(ORIGIN), "Tablet")).toEqual({ ok: true });
    expect(await pk.passkeyRegisterOptions("bad<name>")).toEqual({ error: "name" });
    expect(await audit(inv.id)).toEqual(expect.arrayContaining(["register.failed", "register.reauth_required", "stepup.success"]));
  });

  it("signs in with a discoverable passkey; forged, replayed, unverified and cross-origin assertions fail", async () => {
    const inv = await newInvestor("Bilal Signin");
    await signUpSession(inv.id);
    const auth = new SoftAuthenticator(ORIGIN, { counting: true });
    expect(await register(auth, "Security key")).toEqual({ ok: true });

    expect(await signIn(auth)).toEqual({ ok: true, next: "/account" });
    expect(await session.currentInvestorId()).toBe(inv.id);
    expect((await session.currentSession())?.method).toBe("passkey");

    expect(await signIn(auth, { badSignature: true })).toEqual({ error: "verify" });
    expect(await signIn(auth, { noUserVerification: true })).toEqual({ error: "verify" });
    expect(await signIn(auth, { origin: "http://evil.localhost:3100" })).toEqual({ error: "verify" });
    expect(await signIn(auth, { rpId: "evil.localhost" })).toEqual({ error: "verify" });
    expect(await session.currentInvestorId()).toBeNull();

    // Replay: a valid response for an old challenge, with its ceremony cookie restored.
    jar.clear();
    const o1 = await pk.passkeyLoginOptions();
    if ("error" in o1) throw new Error(o1.error);
    const ceremony = jar.get("pt_passkey_ceremony") ?? "";
    const response = auth.authenticate(o1.options);
    expect(await pk.passkeyLoginVerify(response)).toEqual({ ok: true, next: "/account" });
    jar.clear();
    jar.set("pt_passkey_ceremony", ceremony);
    expect(await pk.passkeyLoginVerify(response)).toEqual({ error: "expired" });
    // The same response against a fresh challenge: the signed challenge does not match.
    jar.clear();
    await pk.passkeyLoginOptions();
    expect(await pk.passkeyLoginVerify(response)).toEqual({ error: "verify" });
    expect(await audit(inv.id)).toEqual(expect.arrayContaining(["login.success", "login.failed"]));
  });

  it("detects a cloned authenticator (counter did not move): refused, passkey revoked, sessions ended", async () => {
    const inv = await newInvestor("Clone Check");
    await signUpSession(inv.id);
    const auth = new SoftAuthenticator(ORIGIN, { counting: true });
    expect(await register(auth, "Key")).toEqual({ ok: true });
    expect(await signIn(auth)).toEqual({ ok: true, next: "/account" });
    const live = jar.get("pt_session") ?? "";
    expect(await signIn(auth, { counter: 1 })).toEqual({ error: "refused" });
    jar.clear();
    jar.set("pt_session", live);
    expect(await session.currentInvestorId()).toBeNull();
    expect(await signIn(auth)).toEqual({ error: "refused" });
    expect(await audit(inv.id)).toContain("login.counter_regression");
  });

  it("asks for a passkey step-up to reserve from PKR 100,000 and to cancel; the database decides", async () => {
    const inv = await newInvestor("Step Up");
    await signUpSession(inv.id);
    const auth = new SoftAuthenticator(ORIGIN);
    expect(await register(auth, "Phone")).toEqual({ ok: true });
    // Fresh registration is not a step-up: reserving 20 units (PKR 100,000) is refused.
    expect(await offering.reserveAction({}, reserveForm("20"))).toEqual({ error: "stepup" });
    expect(await session.requireRecentPasskey("offering.reserve", 10_000_000n)).toEqual({ ok: false, error: "stepup" });
    // Under the threshold no step-up is needed.
    expect(await session.requireRecentPasskey("offering.reserve", 9_999_999n)).toEqual({ ok: true });
    const small = await redirectOf(offering.reserveAction({}, reserveForm("10")));
    expect(small).toMatch(/^\/subscriptions\?sub=/);
    const subId = small.split("sub=")[1] ?? "";
    expect(await offering.cancelReservationAction({}, form({ subscriptionId: subId }))).toEqual({ error: "stepup" });
    // The payout bank account (T-045) always needs it too; refused before the bank service is asked.
    const { registerPayeeAction } = await import("../src/app/actions/account");
    expect(await registerPayeeAction({}, form({ iban: "PK36SCBL0000001123456702", title: "Step Up" }))).toEqual({ error: "stepup" });
    expect(await stepUp(auth)).toEqual({ ok: true });
    expect(await offering.cancelReservationAction({}, form({ subscriptionId: subId }))).toEqual({ ok: true });
    expect(await redirectOf(offering.reserveAction({}, reserveForm("20")))).toMatch(/^\/subscriptions\?sub=/);
    // The investor and subject come from the session: the audit names the session's investor.
    const { rows } = await w.client.query<{ actor: string }>("SELECT DISTINCT actor FROM offering.subscription_events WHERE subscription_id = $1", [subId]);
    expect(rows.map((r) => r.actor)).toContain(`web:${inv.id}`);
    expect(await audit(inv.id)).toEqual(expect.arrayContaining(["stepup.required", "stepup.success"]));
  });

  it("an investor without a passkey keeps reserving and cancelling (waived, audited) until passkeys are required", async () => {
    const inv = await newInvestor("No Passkey");
    await signUpSession(inv.id);
    const r = await redirectOf(offering.reserveAction({}, reserveForm("20")));
    expect(r).toMatch(/^\/subscriptions\?sub=/);
    await w.client.query("UPDATE webauth.settings SET require_passkey = true");
    try {
      expect(await offering.cancelReservationAction({}, form({ subscriptionId: r.split("sub=")[1] ?? "" }))).toEqual({ error: "enrolPasskey" });
    } finally {
      await w.client.query("UPDATE webauth.settings SET require_passkey = false");
    }
    expect(await offering.cancelReservationAction({}, form({ subscriptionId: r.split("sub=")[1] ?? "" }))).toEqual({ ok: true });
    expect(await audit(inv.id)).toEqual(expect.arrayContaining(["stepup.waived", "stepup.required"]));
  });

  it("revokes a passkey after a step-up; it can no longer sign in; logout ends the session in the database", async () => {
    const inv = await newInvestor("Revoke Me");
    await signUpSession(inv.id);
    const auth = new SoftAuthenticator(ORIGIN);
    expect(await register(auth, "Old phone")).toEqual({ ok: true });
    expect(await signIn(auth)).toEqual({ ok: true, next: "/account" });
    const s = await session.currentSession();
    const { listPasskeys } = await import("../src/lib/server/passkeys");
    const ref = (await listPasskeys(s?.hash ?? Buffer.alloc(0), "en"))[0]?.ref ?? "";
    expect(await pk.revokePasskey("not-a-uuid")).toEqual({ error: "unknown" });
    expect(await pk.revokePasskey(ref)).toEqual({ ok: true });
    expect(await signIn(auth)).toEqual({ error: "refused" });

    await signUpSession(inv.id);
    const token = jar.get("pt_session") ?? "";
    const { logout } = await import("../src/app/actions/auth");
    expect(await redirectOf(logout())).toBe("/");
    jar.set("pt_session", token);
    expect(await session.currentInvestorId()).toBeNull();
    expect(await audit(inv.id)).toEqual(expect.arrayContaining(["passkey.revoked", "logout"]));
  });

  it("the audit chain verifies after all of the above", async () => {
    expect((await w.client.query("SELECT * FROM webauth.verify_audit()")).rows).toEqual([]);
  });
});
