import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The investor exit page's server actions and data (S-05 sections 14-15, migration 0027) against
 * PostgreSQL through the website's own role (pt_web_app). The backend's exit test world builds a
 * throw-away database at the latest migration (KYC-verified investors with bound wallets, tokens
 * with holders in the read model); redemption windows are proposed and approved by two operator
 * names as the superuser, then the website talks to it exactly as in production. No chain needed.
 * No investor has a passkey, so the step-up is waived (T-030) and audited as such.
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
}
interface TestToken {
  token: string;
}
interface World {
  su: pg.Client;
  settings: { database?: string };
  drop(): Promise<void>;
}
interface WorldModule {
  createWorld(): Promise<World>;
  investor(w: World): Promise<Investor>;
  exitToken(w: World, holdings: { inv: Investor; units: bigint }[]): Promise<TestToken>;
  sha(label: string): string;
  openGate(w: World): Promise<void>;
  toRedeeming?: (w: World, holdings: { inv: Investor; units: bigint }[]) => Promise<{ t: TestToken; caseId: number; finalId: string }>;
}

// The website's session secret for signed cookies (tests only, when web/.env.local is not loaded).
process.env.WEB_SESSION_SECRET ??= randomBytes(32).toString("base64url");

let m: WorldModule;
let w: World;
let t: TestToken;
let windowId: string;
let laterWindowId: string;
const web = new Map<string, { id: string; inv: Investor | null }>();

type Actions = typeof import("../src/app/actions/exit");
type Lib = typeof import("../src/lib/server/exit");
type Db = typeof import("../src/lib/server/db");
type Session = typeof import("../src/lib/server/session");
let actions: Actions;
let lib: Lib;
let sessions: Session;
let dbm: Db | undefined;
let built = false;

async function webInvestor(name: string, inv: Investor | null): Promise<string> {
  const { rows } = await w.su.query<{ id: string }>(
    "INSERT INTO webdemo.investors (display_name, wallet_address, kyc_status, kyc_subject, onboard_step) VALUES ($1, $2, $3, $4, 'done') RETURNING id",
    [name, inv?.wallet ?? `0x${randomBytes(20).toString("hex")}`, "verified", inv?.subjectId ?? null],
  );
  return rows[0]?.id ?? "";
}

async function signInAs(key: string): Promise<Buffer> {
  jar.clear();
  const who = web.get(key);
  if (!who) throw new Error(`no investor ${key}`);
  await sessions.startSession(who.id);
  const s = await sessions.currentSession();
  if (!s) throw new Error("no session");
  return s.hash;
}

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

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

/** A redemption window proposed by one operator and approved by another (EX-41), as the superuser. */
async function approvedWindow(token: string, opensIn: string, closesIn: string, navPaisa: number, discountPpm: number): Promise<string> {
  const { rows } = await w.su.query<{ id: string }>(
    `SELECT exit.propose_window($1, now() + $2::interval, now() + $3::interval, $4, $5, $6, 'quarterly liquidity window', 'operator:ali')::text AS id`,
    [token, opensIn, closesIn, navPaisa, m.sha(`nav-${token}-${opensIn}`), discountPpm],
  );
  const id = rows[0]?.id ?? "";
  await w.su.query("SELECT exit.decide_window($1, 'operator:bea', 'approve', 'NAV evidence checked against the valuation')", [id]);
  return id;
}

/**
 * Runs where the backend is installed and its PostgreSQL is reachable with the website's role set up
 * (local development); skipped otherwise (the web CI job has no database).
 */
async function databaseReady(): Promise<boolean> {
  const backend = join(import.meta.dirname, "..", "..", "backend");
  const envFile = join(backend, ".env.local");
  if (!existsSync(join(backend, "node_modules", "@pt", "exit")) || !existsSync(join(backend, "packages", "exit", "test", "world.ts")) || !existsSync(envFile)) return false;
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

describe.skipIf(!ready)("investor exit page against PostgreSQL", () => {
  beforeAll(async () => {
    const url = pathToFileURL(join(import.meta.dirname, "..", "..", "backend", "packages", "exit", "test", "world.ts")).href;
    m = (await import(/* @vite-ignore */ url)) as WorldModule;
    w = await m.createWorld();
    built = true;
    const name = w.settings.database ?? "";
    if (!/^pt_scratch_/.test(name)) throw new Error("expected a scratch database");
    process.env.WEB_DB_NAME = name;
    const alice = await m.investor(w);
    const bob = await m.investor(w);
    // Supply 1,200: the window cap is 10 % = 120 units (exit.settings window_cap_ppm).
    t = await m.exitToken(w, [
      { inv: alice, units: 1000n },
      { inv: bob, units: 200n },
    ]);
    web.set("alice", { id: await webInvestor("Test Alice", alice), inv: alice });
    web.set("bob", { id: await webInvestor("Test Bob", bob), inv: bob });
    // A demo persona without any KYC record in the backend.
    web.set("persona", { id: await webInvestor("Persona", null), inv: null });
    // NAV Rs 500.00, 5 % discount: indicative Rs 475.00 per unit (EX-42).
    windowId = await approvedWindow(t.token, "-1 minute", "1 day", 50_000, 50_000);
    laterWindowId = await approvedWindow(t.token, "2 days", "3 days", 50_000, 0);
    sessions = await import("../src/lib/server/session");
    actions = await import("../src/app/actions/exit");
    lib = await import("../src/lib/server/exit");
    dbm = await import("../src/lib/server/db");
  }, 400_000);

  afterAll(async () => {
    if (dbm) await (await dbm.db()).end();
    if (built) await w.drop();
  }, 120_000);

  const requestForm = (over: Record<string, string> = {}) => form({ windowId, units: "10", requestId: randomUUID(), ...over });

  it("sends anyone without a session to sign in", async () => {
    jar.clear();
    expect(await redirectOf(actions.requestRedemptionAction({}, requestForm()))).toBe("/login");
    expect(await redirectOf(actions.withdrawRedemptionAction({}, form({ requestId: randomUUID() })))).toBe("/login");
  });

  it("shows the holding, no exit, and the open and the coming window with the indicative price", async () => {
    const hash = await signInAs("alice");
    const o = await lib.exitOverview(hash);
    if (o === "session") throw new Error("session");
    expect(o.verified).toBe(true);
    expect(o.wallet).toBe(web.get("alice")?.inv?.wallet.toLowerCase());
    expect(o.requests).toEqual([]);
    const h = o.holdings.find((x) => x.token === t.token.toLowerCase());
    expect(h).toMatchObject({ units: 1000n, paused: true, exit: null });
    expect(h?.windows.map((x) => x.id)).toEqual([windowId, laterWindowId]);
    expect(h?.windows[0]).toMatchObject({ navPerUnitPaisa: 50_000n, discountPpm: 50_000, pricePerUnitPaisa: 47_500n, open: true, full: false });
    expect(h?.windows[1]).toMatchObject({ pricePerUnitPaisa: 50_000n, open: false });
  });

  it("checks the input shape and refuses more than the free balance (database)", async () => {
    await signInAs("alice");
    expect(await actions.requestRedemptionAction({}, requestForm({ units: "1.5" }))).toEqual({ error: "input" });
    expect(await actions.requestRedemptionAction({}, requestForm({ units: "0" }))).toEqual({ error: "input" });
    expect(await actions.requestRedemptionAction({}, requestForm({ units: "1001" }))).toEqual({ error: "balance" });
    expect(await actions.requestRedemptionAction({}, requestForm({ windowId: laterWindowId }))).toEqual({ error: "closed" });
    expect(await actions.requestRedemptionAction({}, requestForm({ windowId: "999999" }))).toEqual({ error: "window" });
    const { rows } = await w.su.query("SELECT 1 FROM exit.requests");
    expect(rows).toEqual([]);
  });

  let requestId = "";
  it("requests through the server action (step-up waived), once per form, and shows it on the page data", async () => {
    const hash = await signInAs("alice");
    const formId = randomUUID();
    const to = await redirectOf(actions.requestRedemptionAction({}, requestForm({ units: "100", requestId: formId })));
    requestId = /^\/exit\?req=([0-9a-f-]{36})$/.exec(to)?.[1] ?? "";
    expect(requestId).not.toBe("");
    // The same form again (double click, re-submit after a step-up) is the same request.
    expect(await redirectOf(actions.requestRedemptionAction({}, requestForm({ units: "100", requestId: formId })))).toBe(to);
    // A second request in the same window is refused (one live request per window, EX-43).
    expect(await actions.requestRedemptionAction({}, requestForm({ units: "5" }))).toEqual({ error: "already" });

    const o = await lib.exitOverview(hash);
    if (o === "session") throw new Error("session");
    expect(o.requests).toHaveLength(1);
    expect(o.requests[0]).toMatchObject({ id: requestId, token: t.token.toLowerCase(), windowId, units: 100n, pricePerUnitPaisa: 47_500n, indicativePaisa: 4_750_000n, status: "submitted", withdrawable: true });
    const row = (await w.su.query<{ actor: string; idempotency_key: string }>("SELECT actor, idempotency_key FROM exit.requests WHERE id = $1", [requestId])).rows[0];
    expect(row).toEqual({ actor: `web:${web.get("alice")?.id ?? ""}`, idempotency_key: `web-exit-${formId}` });
    const waived = await w.su.query("SELECT 1 FROM webauth.audit WHERE action = 'stepup.waived' AND detail->>'action' = 'exit.redemption_request'");
    expect(waived.rowCount).toBeGreaterThan(0);
  });

  it("keeps each investor's requests to themselves and refuses a request beyond the window cap", async () => {
    const hash = await signInAs("bob");
    const o = await lib.exitOverview(hash);
    if (o === "session") throw new Error("session");
    expect(o.requests).toEqual([]);
    // 100 of the 120-unit cap are requested: 30 more do not fit (first come, first served).
    expect(await actions.requestRedemptionAction({}, requestForm({ units: "30" }))).toEqual({ error: "full" });
    // Bob cannot withdraw Alice's request.
    expect(await actions.withdrawRedemptionAction({}, form({ requestId }))).toEqual({ error: "unknown" });
  });

  it("refuses an investor without a KYC record (database)", async () => {
    const hash = await signInAs("persona");
    const o = await lib.exitOverview(hash);
    expect(o).toEqual({ verified: false, wallet: null, holdings: [], requests: [] });
    expect(await actions.requestRedemptionAction({}, requestForm())).toEqual({ error: "kyc" });
  });

  it("withdraws through the server action while the window is open, once", async () => {
    const hash = await signInAs("alice");
    expect(await actions.withdrawRedemptionAction({}, form({ requestId: "not-a-uuid" }))).toEqual({ error: "input" });
    expect(await actions.withdrawRedemptionAction({}, form({ requestId: randomUUID() }))).toEqual({ error: "unknown" });
    expect(await actions.withdrawRedemptionAction({}, form({ requestId }))).toEqual({ ok: true });
    expect(await actions.withdrawRedemptionAction({}, form({ requestId }))).toEqual({ error: "state" });
    const o = await lib.exitOverview(hash);
    if (o === "session") throw new Error("session");
    expect(o.requests[0]).toMatchObject({ id: requestId, status: "withdrawn", withdrawable: false });
    // The cap is free again for Bob.
    await signInAs("bob");
    expect(await redirectOf(actions.requestRedemptionAction({}, requestForm({ units: "30" })))).toMatch(/^\/exit\?req=/);
  });

  it("shows a declined request only as under review (no tipping-off)", async () => {
    await w.su.query("ALTER TABLE exit.requests DISABLE TRIGGER requests_guard");
    try {
      await w.su.query("UPDATE exit.requests SET status = 'declined', closed_at = now() WHERE id = $1", [requestId]);
    } finally {
      await w.su.query("ALTER TABLE exit.requests ENABLE TRIGGER requests_guard");
    }
    const o = await lib.exitOverview(await signInAs("alice"));
    if (o === "session") throw new Error("session");
    expect(o.requests[0]).toMatchObject({ id: requestId, status: "under_review", withdrawable: false });
  });

  it("shows the exit timeline and the final entitlement of a case in Redeeming", async (ctx) => {
    if (typeof m.toRedeeming !== "function") ctx.skip();
    const toRedeeming = m.toRedeeming;
    if (!toRedeeming) return;
    await w.su.query("UPDATE ops.settings SET value = 'true' WHERE key = 'allow_placeholder_rates'");
    await w.su.query("UPDATE exit.settings SET value = '0' WHERE key IN ('vote_notice_days', 'record_notice_days')");
    await m.openGate(w);
    const carol = await m.investor(w);
    const dave = await m.investor(w);
    web.set("carol", { id: await webInvestor("Test Carol", carol), inv: carol });
    const r = await toRedeeming(w, [
      { inv: carol, units: 70n },
      { inv: dave, units: 30n },
    ]);
    const o = await lib.exitOverview(await signInAs("carol"));
    if (o === "session") throw new Error("session");
    const h = o.holdings.find((x) => x.token === r.t.token.toLowerCase());
    expect(h?.exit?.state).toBe("redeeming");
    expect(h?.exit?.salePricePaisa).toBe(500_000_000n);
    expect(h?.windows).toEqual([]);
    const line = (await w.su.query<{ gross: string; wht: string; net: string }>("SELECT gross::text, wht::text, net::text FROM exit.final_lines WHERE final_id = $1 AND wallet = $2", [r.finalId, carol.wallet])).rows[0];
    expect(h?.exit?.final).toMatchObject({ units: 70n, grossPaisa: BigInt(line?.gross ?? "-1"), whtPaisa: BigInt(line?.wht ?? "-1"), netPaisa: BigInt(line?.net ?? "-1"), burned: false });
    expect(h?.exit?.final?.payment === null || h?.exit?.final?.payment === "unpaid" || h?.exit?.final?.payment === "held").toBe(true);
    // Requests are closed while an exit is under way (EX-41): no window can even be proposed.
    await expect(approvedWindow(r.t.token, "-1 minute", "1 day", 50_000, 0)).rejects.toThrow(/exit is under way/);
  }, 400_000);
});
