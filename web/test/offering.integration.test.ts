import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The investor offering screens' server actions (S-02, migration 0018) against PostgreSQL, through
 * the website's own role (pt_web_app). The backend's offering test world builds a throw-away
 * database at the latest migration with a live offering (officers, approvals, a token in the read
 * model, the mock bank); the website then talks to it exactly as in production. No chain needed.
 *
 * Next's request APIs are replaced by a cookie jar and fixed headers; redirect() throws.
 */
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
      set: (name: string, value: string) => {
        jar.set(name, value);
      },
      delete: (name: string) => {
        jar.delete(name);
      },
    }),
  headers: () => Promise.resolve(new Headers({ "user-agent": "vitest" })),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

interface Investor {
  subjectId: string;
  wallet: string;
  iban: string;
}
interface Offering {
  id: string;
  d: unknown;
  docs: { en: string; ur: string; risk: string };
  price: bigint;
}
interface World {
  client: pg.Client;
  settings: { database?: string };
  ikyc: { onboard(i: { cnic: string; fullName: string; livenessSessionId: string }): Promise<{ subjectId: string; status: string }> };
  drop(): Promise<void>;
}
interface WorldModule {
  makeWorld(): Promise<World>;
  liveOffering(w: World, o: { cap: bigint; maxUnits: bigint }): Promise<Offering>;
  investor(w: World, d: unknown): Promise<Investor>;
  pay(w: World, inv: Investor, code: string | null, amountPaisa: bigint): Promise<string>;
  ESCROW: string;
}

// The website's session secret for signed cookies (tests only, when web/.env.local is not loaded).
process.env.WEB_SESSION_SECRET ??= randomBytes(32).toString("base64url");

let m: WorldModule;
let w: World;
let o: Offering;
const web = new Map<string, { id: string; subject: string | null; inv?: Investor }>();

type Actions = typeof import("../src/app/actions/offering");
type Lib = typeof import("../src/lib/server/offerings");
type Db = typeof import("../src/lib/server/db");
let actions: Actions;
let lib: Lib;
let dbm: Db | undefined;
let built = false;

/** A website investor row (as sign-up creates it) linked to a KYC subject. */
async function webInvestor(name: string, kycStatus: "verified" | "pending", subject: string | null, wallet = `0x${randomBytes(20).toString("hex")}`): Promise<string> {
  const { rows } = await w.client.query<{ id: string }>(
    "INSERT INTO webdemo.investors (display_name, wallet_address, kyc_status, kyc_subject, onboard_step) VALUES ($1, $2, $3, $4, 'done') RETURNING id",
    [name, wallet, kycStatus, subject],
  );
  return rows[0]?.id ?? "";
}

async function signInAs(key: string): Promise<void> {
  jar.clear();
  const { startSession } = await import("../src/lib/server/session");
  const who = web.get(key);
  if (!who) throw new Error(`no investor ${key}`);
  await startSession(who.id);
}

function form(fields: Record<string, string | null>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== null) f.set(k, v);
  return f;
}

const reserveForm = (over: Record<string, string | null> = {}) =>
  form({
    offeringId: o.id,
    units: "10",
    requestId: randomUUID(),
    language: "en",
    docSha: o.docs.en,
    riskSha: o.docs.risk,
    acceptDoc: "on",
    acceptRisk: "on",
    ...over,
  });

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

const subsOf = async (subject: string) => (await w.client.query<{ id: string; state: string }>("SELECT id, state FROM offering.subscriptions WHERE subject_id = $1", [subject])).rows;

/**
 * Runs where the backend is installed and its PostgreSQL is reachable with the website's role set up
 * (local development); skipped otherwise (the web CI job has no database).
 */
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

describe.skipIf(!ready)("investor offering screens against PostgreSQL", () => {
  beforeAll(async () => {
    const url = pathToFileURL(join(import.meta.dirname, "..", "..", "backend", "packages", "offering", "test", "world.ts")).href;
    m = (await import(/* @vite-ignore */ url)) as WorldModule;
    w = await m.makeWorld();
    built = true;
    const name = w.settings.database ?? "";
    if (!/^pt_scratch_/.test(name)) throw new Error("expected a scratch database");
    process.env.WEB_DB_NAME = name;
    o = await m.liveOffering(w, { cap: 100n, maxUnits: 50n });
    for (const key of ["alice", "bob", "carol"]) {
      const inv = await m.investor(w, o.d);
      web.set(key, { id: await webInvestor(`Test ${key}`, "verified", inv.subjectId, inv.wallet), subject: inv.subjectId, inv });
    }
    // KYC not complete in the backend (mock NADRA unavailable for a CNIC ending in 9).
    const pending = await w.ikyc.onboard({ cnic: `35202${String(1_000_000 + Math.floor(Math.random() * 8_000_000))}9`, fullName: "Pending Person", livenessSessionId: "sess-good-990002" });
    if (pending.status === "verified") throw new Error("expected an unverified subject");
    web.set("pending", { id: await webInvestor("Pending Person", "pending", pending.subjectId), subject: pending.subjectId });
    // The website says verified but the backend does not: only the database gate stops it (WO-2).
    web.set("stale", { id: await webInvestor("Stale Status", "verified", pending.subjectId), subject: pending.subjectId });
    // A demo persona without any KYC record in the backend.
    web.set("persona", { id: await webInvestor("Persona", "verified", null), subject: null });
    actions = await import("../src/app/actions/offering");
    lib = await import("../src/lib/server/offerings");
    dbm = await import("../src/lib/server/db");
  }, 300_000);

  afterAll(async () => {
    if (dbm) await (await dbm.db()).end();
    if (built) await w.drop();
  }, 120_000);

  describe("public offering reads (pt_web, offering.web_offerings)", () => {
    it("lists the live offering with its terms and figures", async () => {
      const list = await lib.listOfferings();
      const mine = list.find((x) => x.offeringId === o.id);
      expect(mine).toMatchObject({ state: "live", pricePaisa: o.price, hardCapUnits: 100n, maxUnits: 50n, minUnits: 10n, allOrNothing: true, docEnSha: o.docs.en, riskSha: o.docs.risk, paidUnits: 0n, availableUnits: 100n });
      expect(mine?.useOfProceeds.reduce((a, x) => a + x.paisa, 0n)).toBe(100n * o.price);
      expect((await lib.offeringById(o.id))?.offeringId).toBe(o.id);
      expect(await lib.offeringById(randomUUID())).toBeNull();
    });
  });

  describe("reserve (server action)", () => {
    it("sends anyone without a session to sign in", async () => {
      jar.clear();
      expect(await redirectOf(actions.reserveAction({}, reserveForm()))).toBe("/login");
    });

    it("refuses investors who are not KYC-verified: on the website and again in the database", async () => {
      await signInAs("pending");
      expect(await actions.reserveAction({}, reserveForm())).toEqual({ error: "kyc" });
      await signInAs("persona");
      expect(await actions.reserveAction({}, reserveForm())).toEqual({ error: "kyc" });
      await signInAs("stale");
      expect(await actions.reserveAction({}, reserveForm())).toEqual({ error: "kyc" });
      expect(await subsOf(web.get("pending")?.subject ?? "")).toEqual([]);
    });

    it("checks the input shape and leaves limits and document versions to the database", async () => {
      await signInAs("alice");
      expect(await actions.reserveAction({}, reserveForm({ acceptRisk: null }))).toEqual({ error: "input" });
      expect(await actions.reserveAction({}, reserveForm({ units: "10.5" }))).toEqual({ error: "input" });
      expect(await actions.reserveAction({}, reserveForm({ units: "51" }))).toEqual({ error: "units" });
      expect(await actions.reserveAction({}, reserveForm({ docSha: "c".repeat(64) }))).toEqual({ error: "docs" });
      expect(await actions.reserveAction({}, reserveForm({ offeringId: randomUUID() }))).toEqual({ error: "unknown" });
      expect(await subsOf(web.get("alice")?.subject ?? "")).toEqual([]);
    });

    it("reserves with the backend's payment instructions, once per request, and shows the timeline", async () => {
      await signInAs("alice");
      const requestId = randomUUID();
      const to = await redirectOf(actions.reserveAction({}, reserveForm({ units: "20", requestId, language: "ur", docSha: o.docs.ur })));
      const id = /^\/subscriptions\?sub=([0-9a-f-]{36})$/.exec(to)?.[1];
      expect(id).toBeDefined();
      // The same request again (double click, retry) is the same subscription.
      expect(await redirectOf(actions.reserveAction({}, reserveForm({ units: "20", requestId, language: "ur", docSha: o.docs.ur })))).toBe(to);
      // A different request while one is open is refused (OF-17).
      expect(await actions.reserveAction({}, reserveForm())).toEqual({ error: "already" });

      const alice = web.get("alice");
      const [s] = await lib.mySubscriptions({ kyc_subject: alice?.subject ?? null });
      expect(s).toMatchObject({ subscriptionId: id, state: "payment_pending", units: 20n, amountPaisa: 20n * o.price, payToAccount: m.ESCROW, refundStatus: null });
      expect(s?.paymentCode).toMatch(/^PT-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
      expect(Date.parse(s?.expiresAt ?? "") - Date.now()).toBeGreaterThan(23 * 3600_000);
      expect(s?.events.map((e) => e.toState)).toEqual(["payment_pending"]);
      const accepted = await w.client.query<{ kind: string; language: string; actor: string }>("SELECT kind, language, actor FROM offering.acceptances WHERE subject_id = $1 ORDER BY id", [alice?.subject]);
      expect(new Set(accepted.rows.map((r) => `${r.kind}/${r.language}/${r.actor}`))).toEqual(new Set([`offering_document/ur/web:${alice?.id ?? ""}`, `risk_disclosure/ur/web:${alice?.id ?? ""}`]));
      expect((await lib.offeringById(o.id))?.heldUnits).toBe(20n);

      // The investor pays by Raast with the code (mock bank): the timeline moves to paid.
      if (!alice?.inv || !s?.paymentCode) throw new Error("setup");
      await m.pay(w, alice.inv, s.paymentCode, s.amountPaisa);
      const [paid] = await lib.mySubscriptions({ kyc_subject: alice.subject });
      expect(paid).toMatchObject({ state: "payment_confirmed", paymentCode: null, payToAccount: null });
      expect(paid?.events.map((e) => e.toState)).toEqual(["payment_pending", "payment_confirmed"]);
      expect((await lib.offeringById(o.id))?.paidUnits).toBe(20n);

      // A paid subscription cannot be cancelled (paid ones are withdrawn under OF-22 only).
      expect(await actions.cancelReservationAction({}, form({ subscriptionId: id ?? "" }))).toEqual({ error: "state" });
    });
  });

  describe("cancel before payment (server action)", () => {
    it("cancels the investor's own reservation, never someone else's", async () => {
      await signInAs("bob");
      const to = await redirectOf(actions.reserveAction({}, reserveForm({ units: "15" })));
      const id = /sub=([0-9a-f-]{36})$/.exec(to)?.[1] ?? "";
      const [before] = await lib.mySubscriptions({ kyc_subject: web.get("bob")?.subject ?? null });
      const code = before?.paymentCode ?? "";
      expect(code).not.toBe("");

      await signInAs("carol");
      expect(await actions.cancelReservationAction({}, form({ subscriptionId: id }))).toEqual({ error: "unknown" });
      expect(await actions.cancelReservationAction({}, form({ subscriptionId: "not-a-uuid" }))).toEqual({ error: "input" });

      await signInAs("bob");
      expect(await actions.cancelReservationAction({}, form({ subscriptionId: id }))).toEqual({ ok: true });
      const [after] = await lib.mySubscriptions({ kyc_subject: web.get("bob")?.subject ?? null });
      expect(after).toMatchObject({ state: "cancelled", paymentCode: null });
      expect(after?.events.map((e) => e.toState)).toEqual(["payment_pending", "cancelled"]);
      // The payment code is dead: the backend recorded its cancellation (a late payment goes to suspense).
      expect((await w.client.query("SELECT 1 FROM bank.intent_cancellations WHERE code = $1", [code])).rows).toHaveLength(1);
      expect((await lib.offeringById(o.id))?.heldUnits).toBe(20n);
    });
  });
});
