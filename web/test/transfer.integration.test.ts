import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { databaseReady, makeTransferWorld, PRICE, type Person, type TransferWorld } from "./transfer-world";

/**
 * The investor transfer screen's server actions and read (S-04 phase 0, spec 16.9, migration 0028)
 * against PostgreSQL through the website's own role (pt_web_app): receive codes, requests, the
 * buyer's acceptance with the agreement fingerprint, withdrawal, the passkey step-up gate and what
 * each party sees. The backend's transfer world (bank, KYC, indexer on a fake chain, officers) is
 * built in a scratch database (test/transfer-world.ts); the website then talks to it exactly as in
 * production. No chain needed.
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

process.env.WEB_SESSION_SECRET ??= randomBytes(32).toString("base64url");

type Actions = typeof import("../src/app/actions/transfer");
type Lib = typeof import("../src/lib/server/transfers");
type Db = typeof import("../src/lib/server/db");
let actions: Actions;
let lib: Lib;
let dbm: Db | undefined;
let tw: TransferWorld | undefined;
let seller: Person;
let buyer: Person;
let stranger: Person;

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

async function signInAs(p: Person): Promise<void> {
  jar.clear();
  const { startSession } = await import("../src/lib/server/session");
  await startSession(p.investorId);
}

/** What the page receives for the signed-in investor (webauth.web_transfers through pt_web). */
async function listOf(p: Person) {
  await signInAs(p);
  const { hashToken } = await import("../src/lib/server/session");
  const list = await lib.myTransfers(hashToken(jar.get("pt_session") ?? ""));
  if (!list) throw new Error("no list");
  return list;
}

function form(fields: Record<string, string | null>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== null) f.set(k, v);
  return f;
}

const world = (): TransferWorld => {
  if (!tw) throw new Error("no world");
  return tw;
};

const requestForm = (code: string, agreement: string, over: Record<string, string | null> = {}) =>
  form({
    token: world().token,
    units: "100",
    buyerCode: code,
    consideration: "sale",
    price: "1,000",
    noPriceReason: null,
    agreementSha256: agreement,
    priceExplanation: null,
    holdingReason: null,
    confirm: "on",
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

/** The buyer's new receive code (server action). */
async function codeFor(p: Person): Promise<string> {
  await signInAs(p);
  const r = await actions.receiveCodeAction();
  if (!r.code) throw new Error(`no code: ${JSON.stringify(r)}`);
  return r.code.code;
}

/** A request from `from` to `to` through the server action; returns the case uuid. */
async function requestCase(from: Person, to: Person, agreement: string, over: Record<string, string | null> = {}): Promise<string> {
  const code = await codeFor(to);
  await signInAs(from);
  const target = await redirectOf(actions.requestTransferAction({}, requestForm(code, agreement, over)));
  const id = /^\/transfers\?case=([0-9a-f-]{36})$/.exec(target)?.[1];
  if (!id) throw new Error(`request failed: ${target}`);
  return id;
}

/** Nothing that identifies the other party may reach the page. */
function expectNoIdentityOf(list: unknown, other: Person): void {
  const text = JSON.stringify(list);
  for (const secret of [other.subjectId, other.wallet, other.wallet.slice(2), other.name, other.investorId, other.iban]) expect(text).not.toContain(secret);
}

const ready = await databaseReady();

describe.skipIf(!ready)("investor transfer screen against PostgreSQL", () => {
  beforeAll(async () => {
    tw = await makeTransferWorld();
    if (!/^pt_scratch_/.test(tw.database)) throw new Error("expected a scratch database");
    process.env.WEB_DB_NAME = tw.database;
    seller = await tw.person(1000n);
    buyer = await tw.person(0n);
    stranger = await tw.person(0n);
    actions = await import("../src/app/actions/transfer");
    lib = await import("../src/lib/server/transfers");
    dbm = await import("../src/lib/server/db");
  }, 400_000);

  afterAll(async () => {
    if (dbm) await (await dbm.db()).end();
    if (tw) await tw.drop();
  }, 120_000);

  it("sends anyone without a session to sign in; an unknown session reads nothing", async () => {
    jar.clear();
    expect(await redirectOf(actions.receiveCodeAction())).toBe("/login");
    expect(await redirectOf(actions.withdrawTransferAction({}, form({ caseId: randomUUID() })))).toBe("/login");
    expect(await lib.myTransfers(randomBytes(32))).toBeNull();
  });

  it("receive codes: made by the server action, listed, at most three live", async () => {
    const before = await listOf(buyer);
    expect(before).toMatchObject({ verified: true, codes: [], cases: [], holdings: [], policyToken: world().token });
    const code = await codeFor(buyer);
    expect(code).toMatch(/^TR-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const after = await listOf(buyer);
    expect(after.codes.map((c) => c.code)).toEqual([code]);
    expect(Date.parse(after.codes[0]?.expiresAt ?? "") - Date.now()).toBeGreaterThan(6 * 24 * 3600_000);
    await codeFor(buyer);
    await codeFor(buyer);
    await signInAs(buyer);
    expect(await actions.receiveCodeAction()).toEqual({ error: "codesMax" });
    expect((await listOf(buyer)).codes).toHaveLength(3);
  });

  it("request: the form shape is checked on the website, every rule again in the database", async () => {
    const agreement = sha256("agreement for refusals");
    const own = await codeFor(seller);
    const theirs = (await listOf(buyer)).codes[0]?.code ?? "";
    await signInAs(seller);
    expect(await actions.requestTransferAction({}, requestForm(theirs, agreement, { confirm: null }))).toEqual({ error: "input" });
    expect(await actions.requestTransferAction({}, requestForm(theirs, agreement, { price: "0" }))).toEqual({ error: "price" });
    expect(await actions.requestTransferAction({}, requestForm(theirs, agreement, { consideration: "gift", noPriceReason: "short" }))).toEqual({ error: "reason" });
    expect(await actions.requestTransferAction({}, requestForm(theirs, agreement, { agreementSha256: "" }))).toEqual({ error: "agreement" });
    expect(await actions.requestTransferAction({}, requestForm(theirs, agreement, { units: "1.5" }))).toEqual({ error: "units" });
    // The database: own code, unknown code, a token the transfer policy does not name.
    expect(await actions.requestTransferAction({}, requestForm(own, agreement))).toEqual({ error: "ownCode" });
    expect(await actions.requestTransferAction({}, requestForm("TR-0000-0000", agreement))).toEqual({ error: "code" });
    expect(await actions.requestTransferAction({}, requestForm(theirs, agreement, { token: `0x${"12".repeat(20)}` }))).toEqual({ error: "token" });
    expect(await world().db.query("SELECT 1 FROM transfer.cases WHERE seller_subject = $1", [seller.subjectId])).toMatchObject({ rowCount: 0 });
  });

  let caseUuid = "";
  const agreement = sha256("the signed share transfer agreement, version 1");

  it("request -> both parties see it with their own role; never the other's identity", async () => {
    const code = (await listOf(buyer)).codes[0]?.code ?? "";
    await signInAs(seller);
    const target = await redirectOf(actions.requestTransferAction({}, requestForm(code, agreement, { priceExplanation: "agreed between us after a valuation" })));
    caseUuid = /^\/transfers\?case=([0-9a-f-]{36})$/.exec(target)?.[1] ?? "";
    expect(caseUuid).not.toBe("");

    const mine = await listOf(seller);
    expect(mine.holdings).toEqual([{ token: world().token, units: "1000" }]);
    expect(mine.cases).toHaveLength(1);
    expect(mine.cases[0]).toMatchObject({
      id: caseUuid,
      role: "seller",
      status: "under_review",
      awaitingAcceptance: true,
      canAccept: false,
      canWithdraw: true,
      token: world().token,
      units: "100",
      consideration: "sale",
      pricePaisa: PRICE.toString(),
      totalPaisa: (100n * PRICE).toString(),
      agreementSha256: agreement,
      payment: null,
      settlement: null,
      refund: null,
    });
    expectNoIdentityOf(mine, buyer);

    const theirs = await listOf(buyer);
    expect(theirs.cases[0]).toMatchObject({ id: caseUuid, role: "buyer", status: "under_review", awaitingAcceptance: true, canAccept: true, canWithdraw: true, units: "100" });
    // The code is used up.
    expect(theirs.codes.map((c) => c.code)).not.toContain(code);
    expectNoIdentityOf(theirs, seller);
    // A third investor sees nothing of it.
    expect((await listOf(stranger)).cases).toEqual([]);
  });

  it("accept: only the buyer, only with the seller's agreement fingerprint, only once", async () => {
    await signInAs(stranger);
    expect(await actions.acceptTransferAction({}, form({ caseId: caseUuid, agreementSha256: agreement }))).toEqual({ error: "unknown" });
    await signInAs(seller);
    expect(await actions.acceptTransferAction({}, form({ caseId: caseUuid, agreementSha256: agreement }))).toEqual({ error: "unknown" });
    await signInAs(buyer);
    expect(await actions.acceptTransferAction({}, form({ caseId: caseUuid, agreementSha256: "not-a-hash" }))).toEqual({ error: "agreement" });
    expect(await actions.acceptTransferAction({}, form({ caseId: caseUuid, agreementSha256: sha256("a different document") }))).toEqual({ error: "mismatch" });
    expect(await actions.acceptTransferAction({}, form({ caseId: caseUuid, agreementSha256: agreement.toUpperCase() }))).toEqual({ ok: true });
    expect(await actions.acceptTransferAction({}, form({ caseId: caseUuid, agreementSha256: agreement }))).toEqual({ error: "notAwaiting" });
    const theirs = await listOf(buyer);
    expect(theirs.cases[0]).toMatchObject({ awaitingAcceptance: false, canAccept: false, status: "under_review" });
  });

  it("approved -> the buyer gets payment instructions (the seller does not); paid -> on chain and no longer withdrawable", async () => {
    expect(await world().act("desk", caseUuid, "complete")).toMatchObject({ ok: true, status: "checks" });
    expect(await world().act("compliance", caseUuid, "approve", "compliance")).toMatchObject({ ok: true, status: "checks" });
    expect(await world().act("trustee", caseUuid, "approve", "trustee")).toMatchObject({ ok: true, status: "awaiting_cash" });

    const theirs = await listOf(buyer);
    const c = theirs.cases[0];
    expect(c).toMatchObject({ status: "approved", canWithdraw: true });
    expect(c?.payment).toMatchObject({ amountPaisa: (100n * PRICE).toString(), paid: false });
    expect(c?.payment?.code).toMatch(/^PT-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(Date.parse(c?.payment?.payUntil ?? "") - Date.now()).toBeGreaterThan(71 * 3600_000);
    expectNoIdentityOf(theirs, seller);
    const mine = await listOf(seller);
    expect(mine.cases[0]).toMatchObject({ status: "approved", payment: null });
    expectNoIdentityOf(mine, buyer);

    await world().pay(buyer, c?.payment?.code ?? "", 100n * PRICE);
    expect(await world().tick()).toBe(1);
    expect(await world().caseStatus(caseUuid)).toBe("proposed");
    const onChain = await listOf(buyer);
    expect(onChain.cases[0]).toMatchObject({ status: "on_chain", payment: null, canWithdraw: false });
    await signInAs(seller);
    expect(await actions.withdrawTransferAction({}, form({ caseId: caseUuid }))).toEqual({ error: "noWithdraw" });
  });

  it("withdraw: the buyer declines, the seller withdraws, a third investor cannot", async () => {
    const gift = await requestCase(seller, buyer, sha256("deed of gift"), { consideration: "gift", price: null, noPriceReason: "a gift to a cousin for his wedding" });
    const listed = (await listOf(buyer)).cases.find((x) => x.id === gift);
    expect(listed).toMatchObject({ consideration: "gift", pricePaisa: null, totalPaisa: null, canAccept: true });
    await signInAs(stranger);
    expect(await actions.withdrawTransferAction({}, form({ caseId: gift }))).toEqual({ error: "unknown" });
    await signInAs(buyer);
    expect(await actions.withdrawTransferAction({}, form({ caseId: "nope" }))).toEqual({ error: "input" });
    expect(await actions.withdrawTransferAction({}, form({ caseId: gift }))).toEqual({ ok: true });
    expect(await actions.withdrawTransferAction({}, form({ caseId: gift }))).toEqual({ error: "noWithdraw" });
    expect((await listOf(seller)).cases.find((x) => x.id === gift)).toMatchObject({ status: "cancelled", canWithdraw: false });

    const sale = await requestCase(seller, stranger, sha256("another agreement"), { units: "5" });
    await signInAs(seller);
    expect(await actions.withdrawTransferAction({}, form({ caseId: sale }))).toEqual({ ok: true });
    expect((await listOf(stranger)).cases.find((x) => x.id === sale)).toMatchObject({ status: "cancelled", canAccept: false });
  });

  it("the database's passkey gate: step-up for every transfer action of an investor with a passkey; enrol once passkeys are required", async () => {
    const holder = await world().person(50n);
    // TEST ONLY: a registered passkey (the website's registration ceremony is covered by the passkey tests).
    await world().db.query(
      "INSERT INTO webauth.passkeys (id, investor_id, name, public_key, counter, aaguid, fmt, device_type, backed_up) VALUES ($1, $2, 'Test key', $3, 0, '00000000-0000-0000-0000-000000000000', 'none', 'singleDevice', false)",
      [randomBytes(24).toString("base64url"), holder.investorId, randomBytes(64)],
    );
    const code = await codeFor(stranger);
    await signInAs(holder);
    // A receive code needs no step-up (it only lets the investor receive).
    expect((await actions.receiveCodeAction()).code?.code).toMatch(/^TR-/);
    expect(await actions.requestTransferAction({}, requestForm(code, agreement, { units: "5" }))).toEqual({ error: "stepup" });
    expect(await actions.acceptTransferAction({}, form({ caseId: randomUUID(), agreementSha256: agreement }))).toEqual({ error: "stepup" });
    expect(await actions.withdrawTransferAction({}, form({ caseId: randomUUID() }))).toEqual({ error: "stepup" });
    expect(await world().db.query("SELECT 1 FROM transfer.cases WHERE seller_subject = $1", [holder.subjectId])).toMatchObject({ rowCount: 0 });
    // The receive code was not used by the refused request.
    expect((await listOf(stranger)).codes.map((c) => c.code)).toContain(code);

    await world().db.query("UPDATE webauth.settings SET require_passkey = true");
    try {
      await signInAs(stranger);
      expect(await actions.withdrawTransferAction({}, form({ caseId: randomUUID() }))).toEqual({ error: "enrolPasskey" });
      expect(await actions.requestTransferAction({}, requestForm(code, agreement))).toEqual({ error: "enrolPasskey" });
    } finally {
      await world().db.query("UPDATE webauth.settings SET require_passkey = false");
    }
    const audit = await world().db.query<{ action: string }>("SELECT DISTINCT action FROM webauth.audit WHERE actor = $1", [`web:${holder.investorId}`]);
    expect(audit.rows.map((r) => r.action)).toContain("stepup.required");
  });
});
