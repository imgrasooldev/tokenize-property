import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * T-045 against PostgreSQL through the website's own role (pt_web_app): the public catalogue built
 * from offering + property records (migration 0022 WA-3/WA-4), the reconciliation status (WA-5) and
 * the payout-account flow (WA-2 reads; registration through the bank service's HTTP API, here started
 * in-process with the backend's offering test world and its mock bank as the title inquiry).
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
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

interface Investor {
  subjectId: string;
  name: string;
  wallet: string;
  iban: string;
}
interface World {
  client: pg.Client;
  pool: pg.Pool;
  settings: { database?: string };
  bank: { registerPayee(subjectId: string, iban: string, claimedTitle?: string): Promise<bigint> };
  mock: { openAccount(iban: string, title: string): void };
  drop(): Promise<void>;
}
interface WorldModule {
  makeWorld(): Promise<World>;
  liveOffering(w: World, o: { cap: bigint; maxUnits: bigint }): Promise<{ id: string; d: unknown; price: bigint; propertyId: string }>;
  investor(w: World, d: unknown, o?: { payee?: boolean }): Promise<Investor>;
  passRecon(w: World): Promise<void>;
}
interface BankModule {
  createPayeeServer(api: { registerPayee(s: string, iban: string, title: string): Promise<bigint> }, clients: { id: string; secret: Buffer; scope: readonly string[] }[]): Server;
  WEB_BANK_SCOPE: readonly string[];
  makeIban(bank: string, account: string): string;
}

process.env.WEB_SESSION_SECRET ??= randomBytes(32).toString("base64url");

const backend = join(import.meta.dirname, "..", "..", "backend");
const envFile = join(backend, ".env.local");

async function databaseReady(): Promise<boolean> {
  if (!existsSync(join(backend, "node_modules", "@pt", "bank")) || !existsSync(envFile)) return false;
  const env = readFileSync(envFile, "utf8");
  if (!/^WEB_PG_USER=/m.test(env) || !/^WEB_PG_PASSWORD=/m.test(env) || !/^BANK_CLIENT_SECRET_WEB=/m.test(env)) return false;
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

let m: WorldModule;
let bankm: BankModule;
let w: World;
let built = false;
let server: Server | undefined;
let offering: { id: string; d: unknown; price: bigint };
let dbm: typeof import("../src/lib/server/db") | undefined;

async function webInvestor(name: string, subject: string | null): Promise<string> {
  const { rows } = await w.client.query<{ id: string }>(
    "INSERT INTO webdemo.investors (display_name, wallet_address, kyc_status, kyc_subject, onboard_step) VALUES ($1, $2, 'verified', $3, 'done') RETURNING id",
    [name, `0x${randomBytes(20).toString("hex")}`, subject],
  );
  return rows[0]?.id ?? "";
}

async function signInAs(id: string): Promise<void> {
  jar.clear();
  const { startSession } = await import("../src/lib/server/session");
  await startSession(id);
}

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

describe.skipIf(!ready)("T-045 catalogue and payout accounts against PostgreSQL", () => {
  beforeAll(async () => {
    m = (await import(/* @vite-ignore */ pathToFileURL(join(backend, "packages", "offering", "test", "world.ts")).href)) as WorldModule;
    bankm = (await import(/* @vite-ignore */ pathToFileURL(join(backend, "packages", "bank", "src", "index.ts")).href)) as BankModule;
    w = await m.makeWorld();
    built = true;
    const name = w.settings.database ?? "";
    if (!/^pt_scratch_/.test(name)) throw new Error("expected a scratch database");
    process.env.WEB_DB_NAME = name;
    offering = await m.liveOffering(w, { cap: 100n, maxUnits: 50n });
    // The bank service's website API, in-process, with the world's bank (mock title inquiry).
    const secret = /^BANK_CLIENT_SECRET_WEB=(.+)$/m.exec(readFileSync(envFile, "utf8"))?.[1]?.trim() ?? "";
    server = bankm.createPayeeServer({ registerPayee: (s, iban, title) => w.bank.registerPayee(s, iban, title) }, [
      { id: "web", secret: Buffer.from(secret, "base64url"), scope: bankm.WEB_BANK_SCOPE },
    ]);
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    process.env.BANK_PAYEES_URL = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    dbm = await import("../src/lib/server/db");
  }, 300_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (server) server.close(() => {
        resolve();
      });
      else resolve();
    });
    if (dbm) await (await dbm.db()).end();
    if (built) await w.drop();
  }, 120_000);

  it("lists the live offering with public property facts, published hashes and a rule-based score", async () => {
    const { catalog, catalogEntry } = await import("../src/lib/server/catalog");
    const cat = await catalog();
    const e = cat.entries.find((x) => x.key === offering.id);
    expect(e).toBeDefined();
    expect(e).toMatchObject({ status: "open", href: `/properties/${offering.id}`, province: "punjab", district: "Lahore", use: "commercial", issuePricePaisa: offering.price });
    expect(e?.facts).toMatchObject({ occupancy: "vacant", structureKind: "spv", shariah: false, sponsorKybApproved: true, valuations: 2 });
    expect(e?.facts?.valuationLowPaisa).toBe(10_000_000_000n);
    expect(e?.facts?.trusteeAcceptedAt).not.toBeNull();
    // Published hashes: allow-listed types only, current versions only; KYB and private documents never.
    const types = new Set(e?.documents.map((d) => d.docType));
    expect(types.has("title_deed")).toBe(true);
    expect(types.has("trust_deed")).toBe(true);
    expect(types.has("utility_bill")).toBe(false);
    expect(types.has("certificate_of_incorporation")).toBe(false);
    expect(e?.documents.find((d) => d.docType === "title_deed")?.verified).toBe(true);
    for (const d of e?.documents ?? []) expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Score inputs from records: vacant (0), documents (title, valuation, trust deed, insurance = 100), no recon run yet.
    expect(e?.score.factors.find((f) => f.key === "occupancy")?.points).toBe(0);
    expect(e?.score.factors.find((f) => f.key === "documents")?.points).toBe(100);
    expect(e?.score.factors.find((f) => f.key === "reconciliation")?.points).toBeNull();
    expect((await catalogEntry(offering.id))?.key).toBe(offering.id);
    expect(await catalogEntry("../../etc")).toBeUndefined();
    expect(await catalogEntry("00000000-0000-4000-8000-000000000000")).toBeUndefined();
  });

  it("reads the latest reconciliation status (passed/failed only, never findings)", async () => {
    await m.passRecon(w);
    const { reconSummary } = await import("../src/lib/server/catalog");
    expect(await reconSummary(true)).toMatchObject({ status: "passed", blocking: 0 });
  });

  it("registers a payout account through the bank service and shows only the last four digits", async () => {
    const inv = await m.investor(w, offering.d, { payee: false });
    const id = await webInvestor("Payee Test", inv.subjectId);
    const { registerPayeeAction } = await import("../src/app/actions/account");
    const { payoutAccounts } = await import("../src/lib/server/payees");
    await signInAs(id);
    // Title must match the KYC-verified name (mock bank returns the account's real title).
    w.mock.openAccount(inv.iban, inv.name);
    expect(await registerPayeeAction({}, form({ iban: inv.iban, title: inv.name }))).toEqual({ ok: true });
    const list = await payoutAccounts(inv.subjectId);
    expect(list).toHaveLength(1);
    const p = list?.[0];
    expect(p?.last4).toBe(inv.iban.slice(-4));
    expect(Date.parse(p?.activeFrom ?? "") - Date.parse(p?.registeredAt ?? "")).toBe(72 * 3_600_000);
    expect(JSON.stringify(list)).not.toContain(inv.iban);
    // Another investor's view never shows it.
    expect(await payoutAccounts((await m.investor(w, offering.d, { payee: false })).subjectId)).toEqual([]);
  });

  it("refuses a title that does not match the verified name, unknown accounts and bad input", async () => {
    const inv = await m.investor(w, offering.d, { payee: false });
    const id = await webInvestor("Mismatch Test", inv.subjectId);
    const { registerPayeeAction } = await import("../src/app/actions/account");
    await signInAs(id);
    const other = bankm.makeIban("HABB", String(Date.now()).padStart(16, "0").slice(-16));
    w.mock.openAccount(other, "Somebody Else");
    expect(await registerPayeeAction({}, form({ iban: other, title: "Somebody Else" }))).toEqual({ error: "title_mismatch" });
    const unknown = bankm.makeIban("MEZN", "9".repeat(16));
    expect(await registerPayeeAction({}, form({ iban: unknown, title: inv.name }))).toEqual({ error: "title_not_found" });
    expect(await registerPayeeAction({}, form({ iban: "PK00 NOT AN IBAN", title: inv.name }))).toEqual({ error: "invalid_iban" });
    expect(await registerPayeeAction({}, form({ iban: inv.iban, title: "<script>" }))).toEqual({ error: "input" });
  });

  it("a demo persona without a KYC record cannot register, and anonymous users are sent to sign in", async () => {
    const id = await webInvestor("Persona", null);
    const { registerPayeeAction } = await import("../src/app/actions/account");
    await signInAs(id);
    expect(await registerPayeeAction({}, form({ iban: "PK36SCBL0000001123456702", title: "Persona" }))).toEqual({ error: "noKyc" });
    jar.clear();
    await expect(registerPayeeAction({}, form({ iban: "PK36SCBL0000001123456702", title: "X Y" }))).rejects.toThrow("REDIRECT /login");
  });
});
