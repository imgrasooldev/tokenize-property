import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The investor notification centre (T-028, migration 0030 NP-8) against PostgreSQL through the
 * website's own role (pt_web_app): the backend's tax test world builds a throw-away database at the
 * latest migration with KYC-verified investors (whose verification already raised a notice through
 * the KYC producer); the website lists, marks read and saves settings exactly as in production.
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

interface World {
  su: pg.Client;
  settings: { database?: string };
  drop(): Promise<void>;
}
interface WorldModule {
  createWorld(): Promise<World>;
  investor(w: World): Promise<{ subjectId: string; wallet: string }>;
}

process.env.WEB_SESSION_SECRET ??= randomBytes(32).toString("base64url");

let m: WorldModule;
let w: World;
let built = false;
let actions: typeof import("../src/app/actions/notifications");
let lib: typeof import("../src/lib/server/notifications");
let sessions: typeof import("../src/lib/server/session");
let dbm: typeof import("../src/lib/server/db") | undefined;
const people = new Map<string, { id: string; subject: string | null }>();

async function webInvestor(name: string, subject: string | null, wallet: string): Promise<string> {
  const { rows } = await w.su.query<{ id: string }>(
    "INSERT INTO webdemo.investors (display_name, wallet_address, kyc_status, kyc_subject, onboard_step) VALUES ($1, $2, 'verified', $3, 'done') RETURNING id",
    [name, wallet, subject],
  );
  return rows[0]?.id ?? "";
}

async function signInAs(key: string): Promise<Buffer> {
  jar.clear();
  const who = people.get(key);
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
    await p;
    return "returned";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.startsWith("REDIRECT ")) throw e;
    return msg.slice("REDIRECT ".length);
  }
}

async function databaseReady(): Promise<boolean> {
  const backend = join(import.meta.dirname, "..", "..", "backend");
  const envFile = join(backend, ".env.local");
  if (!existsSync(join(backend, "node_modules", "@pt", "notify")) || !existsSync(join(backend, "packages", "tax", "test", "world.ts")) || !existsSync(envFile)) return false;
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

describe.skipIf(!ready)("investor notification centre against PostgreSQL", () => {
  beforeAll(async () => {
    const url = pathToFileURL(join(import.meta.dirname, "..", "..", "backend", "packages", "tax", "test", "world.ts")).href;
    m = (await import(/* @vite-ignore */ url)) as WorldModule;
    w = await m.createWorld();
    built = true;
    const name = w.settings.database ?? "";
    if (!/^pt_scratch_/.test(name)) throw new Error("expected a scratch database");
    process.env.WEB_DB_NAME = name;
    const alice = await m.investor(w);
    const bob = await m.investor(w);
    people.set("alice", { id: await webInvestor("Test Alice", alice.subjectId, alice.wallet), subject: alice.subjectId });
    people.set("bob", { id: await webInvestor("Test Bob", bob.subjectId, bob.wallet), subject: bob.subjectId });
    people.set("persona", { id: await webInvestor("Persona", null, `0x${randomBytes(20).toString("hex")}`), subject: null });
    // A transactional notice as a producer raises it (the offering producer is tested in the backend).
    await w.su.query("SELECT notify.enqueue($1, 'offering.waitlisted', 'investor', $2, '{\"offering\": \"Gulberg Heights\"}', 'producer:test')", [`web-test:${randomUUID()}`, alice.subjectId]);
    sessions = await import("../src/lib/server/session");
    actions = await import("../src/app/actions/notifications");
    lib = await import("../src/lib/server/notifications");
    dbm = await import("../src/lib/server/db");
  }, 400_000);

  afterAll(async () => {
    if (dbm) await (await dbm.db()).end();
    if (built) await w.drop();
  }, 120_000);

  it("sends anyone without a session to sign in", async () => {
    jar.clear();
    expect(await redirectOf(actions.markReadAction(form({ id: "all" })))).toBe("/login");
    expect(await redirectOf(actions.saveNotifySettingsAction(form({ locale: "ur" })))).toBe("/login");
  });

  it("lists the investor's own notices, rendered in the chosen language; another investor sees none of them", async () => {
    const a = await signInAs("alice");
    const en = await lib.inbox(a, "en");
    expect(en.map((n) => n.kind)).toEqual(["offering.waitlisted", "security.kyc_status_changed"]);
    expect(en[0]?.title).toBe("You are on the waiting list");
    expect(en[0]?.paragraphs[0]).toContain("Gulberg Heights");
    expect(en[1]?.paragraphs[0]).toContain("verified");
    expect(en.every((n) => !n.read)).toBe(true);
    const ur = await lib.inbox(a, "ur");
    expect(ur[0]?.title).toMatch(/[؀-ۿ]/);
    expect(ur[0]?.paragraphs[0]).toContain("\u2066Gulberg Heights\u2069");
    expect(await lib.unreadCount(a)).toBe(2);
    const b = await signInAs("bob");
    expect((await lib.inbox(b, "en")).map((n) => n.kind)).toEqual(["security.kyc_status_changed"]);
    // Bob cannot mark Alice's notice read.
    expect(await redirectOf(actions.markReadAction(form({ id: en[0]?.id ?? "" })))).toBe("/notifications");
    const a2 = await signInAs("alice");
    expect(await lib.unreadCount(a2)).toBe(2);
  });

  it("marks one and then all as read", async () => {
    const a = await signInAs("alice");
    const items = await lib.inbox(a, "en");
    expect(await redirectOf(actions.markReadAction(form({ id: items[0]?.id ?? "" })))).toBe("/notifications");
    expect(await lib.unreadCount(a)).toBe(1);
    expect(await redirectOf(actions.markReadAction(form({ id: "all" })))).toBe("/notifications");
    expect(await lib.unreadCount(a)).toBe(0);
    expect((await lib.inbox(a, "en")).every((n) => n.read)).toBe(true);
    expect(await redirectOf(actions.markReadAction(form({ id: "1; DROP TABLE x" })))).toBe("/notifications?e=invalid");
  });

  it("saves settings: language, updates by e-mail only, offers by SMS with the consent version", async () => {
    const a = await signInAs("alice");
    expect(await lib.notifySettings(a)).toMatchObject({ locale: "en", smsEnabled: true, emailEnabled: true, smsMarketing: false, emailMarketing: false, smsOnFile: false });
    expect(await redirectOf(actions.saveNotifySettingsAction(form({ locale: "ur", email: "on", mktSms: "on" })))).toBe("/notifications?saved=1#settings");
    expect(await lib.notifySettings(a)).toMatchObject({ locale: "ur", smsEnabled: false, emailEnabled: true, smsMarketing: true, emailMarketing: false });
    const { rows } = await w.su.query<{ text_version: string; granted: boolean; channel: string }>(
      "SELECT c.text_version, c.granted, c.channel FROM notify.consents c JOIN notify.recipients r ON r.id = c.recipient_id WHERE r.subject_id = $1",
      [people.get("alice")?.subject],
    );
    expect(rows).toEqual([{ text_version: "mkt-2026-10", granted: true, channel: "sms" }]);
    expect(await redirectOf(actions.saveNotifySettingsAction(form({ locale: "fr" })))).toBe("/notifications?e=invalid#settings");
  });

  it("an investor without a KYC record has nothing to read or configure", async () => {
    const p = await signInAs("persona");
    expect(await lib.inbox(p, "en")).toEqual([]);
    expect(await lib.notifySettings(p)).toBeNull();
    expect(await redirectOf(actions.saveNotifySettingsAction(form({ locale: "ur" })))).toBe("/notifications?e=invalid#settings");
  });
});
