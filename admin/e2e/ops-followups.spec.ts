import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type pg from "pg";
import { passRecon } from "../test/support/approvals";
import { operationsWorld } from "../test/support/operations";
import { connect, enrolAndSignIn, enrolLink, pageWithKey, warm } from "./helpers";

/**
 * PT Control screens of 2026-10-29/30 in a real browser with virtual FIDO2 keys: a property manager
 * sees only the property assigned to them (migration 0034); a credit in suspense goes back to its
 * payer maker-checker (0038); a tenant rent invoice is issued, paid by a bank line and approved
 * (0044); a token-holder poll is proposed and approved by the trustee (0046). Every action needs the
 * officer's security key. Screenshots go to screenshots/followups2-*.png.
 */
test.skip(process.env.SCREENSHOTS === "1", "the screenshot run uses the development database");
test.describe.configure({ mode: "serial" });

const sha = (t: string) => createHash("sha256").update(t, "utf8").digest();
const short = (hex: string) => `${hex.slice(0, 8)}…${hex.slice(-6)}`;
let db: Awaited<ReturnType<typeof connect>>;
let counter = Date.now();
let a1: Buffer;
let a2: Buffer;
let links: { maker: string; checker: string; manager: string; trustee: string; maker2: string; checker2: string; maker3: string };
let mine = "";
let other = "";

async function adminSession(su: pg.Client, handle: string): Promise<Buffer> {
  const cred = await su.query<{ id: string }>("SELECT c.id FROM admin.credentials c JOIN admin.officers o ON o.id = c.officer_id WHERE o.handle = $1", [handle]);
  const t = randomBytes(32).toString("base64url");
  await su.query("SELECT admin.start_session($1, $2, $3)", [sha(t), cred.rows[0]?.id, ++counter]);
  return sha(t);
}

async function admins(): Promise<[Buffer, Buffer]> {
  const have = await db.su.query("SELECT 1 FROM admin.officers WHERE handle IN ('e2e.admin1', 'e2e.admin2') AND status = 'active'");
  if (have.rowCount !== 2) {
    for (const [handle, name] of [["e2e.admin1", "Ayesha Admin"], ["e2e.admin2", "Bilal Admin"]] as const) {
      const link = randomBytes(32).toString("base64url");
      await db.cli.query("SELECT admin.bootstrap_admin($1, $2, $3, 'cli:e2e')", [handle, name, sha(link)]);
      await db.su.query("SELECT admin.complete_enrolment($1, $2, $3, 0, '{usb}', '00000000-0000-0000-0000-000000000000', 'packed', 'singleDevice', false, true)", [
        sha(link),
        randomBytes(20).toString("base64url"),
        randomBytes(77),
      ]);
    }
  }
  return [await adminSession(db.su, "e2e.admin1"), await adminSession(db.su, "e2e.admin2")];
}

async function invite(handle: string, name: string, role: string): Promise<string> {
  const { rows } = await db.su.query<{ id: string }>("SELECT admin.request_change($1, 'invite', NULL, $2, $3, $4, 'officer for the follow-ups e2e') AS id", [a1, role, handle, name]);
  await db.su.query("SELECT admin.decide_change($1, $2, 'approve', 'approved for the follow-ups e2e')", [a2, rows[0]?.id]);
  return enrolLink(db.cli, handle);
}

/** Submits a step-up form and waits for its own redirect (a previous message may still be on the page). */
async function submit(page: Page, button: string, path: RegExp, within: Locator | Page = page): Promise<void> {
  const done = page.waitForResponse((r) => path.test(new URL(r.url()).pathname) && r.request().method() === "POST");
  await within.getByRole("button", { name: button }).click();
  await done;
  await page.waitForLoadState("load");
}

/** A property file and its completed offering for a token (TEST ONLY: written directly, foreign keys off). */
async function propertyFor(token: string): Promise<string> {
  await db.su.query("SET session_replication_role = replica");
  try {
    const p = await db.su.query<{ id: string }>("INSERT INTO property.properties (sponsor_id, created_by, district) VALUES (gen_random_uuid(), 'test-setup', 'Lahore') RETURNING id");
    await db.su.query(
      `INSERT INTO offering.offerings (property_id, state, price_paisa, min_units, max_units, max_holding_units, register_units, token, completed_at, created_by)
       VALUES ($1, 'completed', 100000, 10, 100000, 100000, 1000000, $2, now(), 'test-setup')`,
      [p.rows[0]?.id, token],
    );
    return p.rows[0]?.id ?? "";
  } finally {
    await db.su.query("RESET session_replication_role");
  }
}

test.beforeAll(async () => {
  mkdirSync("screenshots", { recursive: true });
  db = await connect();
  await warm();
  for (const p of ["/operations", "/operations/bank", "/operations/invoices", "/votes", "/api/operations/invoices", "/api/operations/invoices/1/act", "/api/operations/collections/1/decide", "/api/operations/bank/returns", "/api/operations/bank/returns/1/decide", "/api/votes", "/api/votes/1/act"]) {
    await fetch(`http://localhost:3301${p}`, { redirect: "manual", signal: AbortSignal.timeout(170_000) }).catch(() => undefined);
  }
  [a1, a2] = await admins();
  links = {
    maker: await invite("e2e.maker5", "Rehan Maker", "ops_maker"),
    checker: await invite("e2e.checker5", "Sadia Checker", "ops_checker"),
    manager: await invite("e2e.pm1", "Usman Manager", "property_manager"),
    trustee: await invite("e2e.trustee5", "Hamid Trustee", "trustee_officer"),
    // One-time enrolment links: each test enrols its own officers.
    maker2: await invite("e2e.maker6", "Zoya Maker", "ops_maker"),
    checker2: await invite("e2e.checker6", "Kashif Checker", "ops_checker"),
    maker3: await invite("e2e.maker7", "Bushra Maker", "ops_maker"),
  };
  const wallet = () => `0x${randomBytes(20).toString("hex")}`;
  mine = (await operationsWorld(db.su, [{ wallet: wallet(), units: 10n }])).token;
  other = (await operationsWorld(db.su, [{ wallet: wallet(), units: 10n }])).token;
});
test.afterAll(async () => {
  await db.end();
});

test("a property manager sees only the property assigned to them", async ({ browser }) => {
  const property = await propertyFor(mine);
  await propertyFor(other);
  const pm = await db.su.query<{ id: string }>("SELECT id FROM admin.officers WHERE handle = 'e2e.pm1'");
  // Two administrators assign it (maker-checker; their screens are covered by the DB tests).
  const ask = (await db.su.query<{ r: { id: number } }>("SELECT admin.request_manager_scope($1, $2, $3, 'grant', 'manages this tower for the trust') AS r", [a1, pm.rows[0]?.id, property])).rows[0]?.r;
  await db.su.query("SELECT admin.decide_manager_scope($1, $2, 'approve', 'management contract on file') AS r", [a2, ask?.id]);

  const m = await pageWithKey(browser);
  await enrolAndSignIn(m.page, links.manager, /\/operations$/);
  const periods = m.page.getByTestId("periods");
  await expect(periods).toContainText(short(mine));
  await expect(periods).not.toContainText(short(other));
  await m.page.screenshot({ path: "screenshots/followups2-01-manager.png", fullPage: true });
  await m.page.context().close();
});

test("a credit in suspense goes back to its payer: a maker asks, a different checker approves", async ({ browser }) => {
  await passRecon(db.su);
  const ref = `RAAST-E2E-${randomBytes(4).toString("hex").toUpperCase()}`;
  await db.su.query("INSERT INTO bank.events (event_id, type, body_sha256, key_id) VALUES ($1, 'credit.received', $2, 'k1')", [`evt-${ref}`, randomBytes(32)]);
  await db.su.query("SELECT bank.book_credit($1, $2::jsonb, 'bank-webhook')", [
    `evt-${ref}`,
    JSON.stringify({ raastRef: ref, amountPaisa: "4200", valueDate: "2026-10-20", payerHash: randomBytes(32).toString("hex"), payerLast4: "9876", intentCode: null }),
  ]);
  const m = await pageWithKey(browser);
  await enrolAndSignIn(m.page, links.maker, /\/$/);
  await m.page.goto("/operations/bank");
  const credit = m.page.getByTestId("suspense").locator("article").filter({ hasText: ref });
  await credit.getByPlaceholder("Why it goes back (at least 10 characters)").fill("No payment code and no registered account");
  await submit(m.page, "Ask to return to the payer", /\/api\/operations\/bank\/returns$/, credit);
  await expect(m.page.getByTestId("decision-ok")).toContainText("requested");

  const c = await pageWithKey(browser);
  await enrolAndSignIn(c.page, links.checker, /\/$/);
  await c.page.goto("/operations/bank");
  const request = c.page.getByTestId("suspense").locator("article").filter({ hasText: `Return ${ref}` });
  await request.getByPlaceholder("Reason (at least 10 characters)").fill("Checked with the bank: return it to the sender");
  await submit(c.page, "Approve with security key", /\/api\/operations\/bank\/returns\/\d+\/decide$/, request);
  await expect(c.page.getByTestId("decision-ok")).toContainText("returned");
  await c.page.screenshot({ path: "screenshots/followups2-02-suspense.png", fullPage: true });
  const ret = await db.su.query<{ returned_by: string }>("SELECT returned_by FROM bank.credit_returns WHERE raast_ref = $1", [ref]);
  expect(ret.rows[0]?.returned_by).toBe("e2e.checker5");
  await m.page.context().close();
  await c.page.context().close();
});

test("a tenant rent invoice is issued with a one-time link, paid by a bank line and approved by a checker", async ({ browser }) => {
  const account = `E2E-RENT-${randomBytes(3).toString("hex").toUpperCase()}`;
  await db.su.query("SELECT ledger.open_account($1, 'asset', 'PKR')", [`bank:${account.toLowerCase()}`]);
  await db.su.query("SELECT recon.register_bank_account($1, $2, 'test:setup')", [account, `bank:${account.toLowerCase()}`]);
  const today = (await db.su.query<{ d: string }>("SELECT current_date::text AS d")).rows[0]?.d ?? "";
  await db.su.query("SELECT recon.import_bank_statement('test:import', $1, $2::date, 0, 8800000, $3::jsonb)", [
    account,
    today,
    JSON.stringify([{ valueDate: today, amountPaisa: "8800000", reference: `RAAST-SHOP-${randomBytes(3).toString("hex").toUpperCase()}`, counterparty: "Shop 7", balancePaisa: "8800000" }]),
  ]);

  const m = await pageWithKey(browser);
  await enrolAndSignIn(m.page, links.maker2, /\/$/);
  await m.page.goto("/operations/invoices");
  await m.page.locator("#token").selectOption(mine);
  await m.page.locator("#period").fill("2026-11");
  await m.page.locator("#due").fill(today);
  await m.page.locator("#tenant").fill("Shop 7, first floor");
  await m.page.locator("#rupees").fill("88000");
  await submit(m.page, "Issue with security key", /\/api\/operations\/invoices$/);
  await expect(m.page.getByTestId("invoice-link")).toContainText("/pay/");
  const invoice = m.page.getByTestId("invoices").locator("article").filter({ hasText: "Shop 7, first floor" });
  await submit(m.page, "Record payment (a checker approves)", /\/api\/operations\/invoices\/\d+\/act$/, invoice);
  await expect(m.page.getByTestId("decision-ok")).toContainText("Collection");

  const c = await pageWithKey(browser);
  await enrolAndSignIn(c.page, links.checker2, /\/$/);
  await c.page.goto("/operations/invoices");
  const pending = c.page.getByTestId("invoices").locator("article").filter({ hasText: "Shop 7, first floor" });
  await pending.getByPlaceholder("Reason (at least 10 characters)").fill("Bank line matches the tenant invoice");
  await submit(c.page, "Approve collection", /\/api\/operations\/collections\/\d+\/decide$/, pending);
  await expect(c.page.getByTestId("decision-ok")).toContainText("approved");
  await c.page.screenshot({ path: "screenshots/followups2-03-invoice.png", fullPage: true });
  const inv = await db.su.query<{ status: string }>("SELECT status FROM ops.rent_invoices WHERE tenant_label = 'Shop 7, first floor'");
  expect(inv.rows[0]?.status).toBe("paid");
  await m.page.context().close();
  await c.page.context().close();
});

test("a token-holder poll is proposed by a maker and approved by a trustee officer", async ({ browser }) => {
  const cursor = (await db.su.query<{ n: string }>("SELECT c.block_number::text AS n FROM chain.tokens t JOIN chain.cursors c ON c.deployment = t.deployment WHERE t.token = $1", [mine])).rows[0]?.n ?? "1";
  const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const m = await pageWithKey(browser);
  await enrolAndSignIn(m.page, links.maker3, /\/$/);
  await m.page.goto("/votes");
  await m.page.locator("#token").selectOption(mine);
  await m.page.locator("#recordBlock").fill(cursor);
  await m.page.locator("#quorum").fill("25");
  await m.page.locator("#title").fill("Renew the anchor lease");
  await m.page.locator("#question").fill("Should the trust renew the anchor tenant lease for five years?");
  await m.page.locator("#opens").fill(local(new Date(Date.now() + 60_000)));
  await m.page.locator("#closes").fill(local(new Date(Date.now() + 3 * 86_400_000)));
  await submit(m.page, "Propose with security key", /\/api\/votes$/);
  await expect(m.page.getByTestId("decision-ok")).toContainText("proposed");

  const t = await pageWithKey(browser);
  await enrolAndSignIn(t.page, links.trustee, /\/trustee$/);
  await t.page.goto("/votes");
  const poll = t.page.getByTestId("polls").locator("article").filter({ hasText: "Renew the anchor lease" });
  await poll.getByPlaceholder("Reason (at least 10 characters)").fill("Terms match the trust deed");
  await submit(t.page, "Approve with security key", /\/api\/votes\/\d+\/act$/, poll);
  await expect(t.page.getByTestId("decision-ok")).toContainText("approved");
  await t.page.screenshot({ path: "screenshots/followups2-04-poll.png", fullPage: true });
  const p = await db.su.query<{ status: string; decided_by: string }>("SELECT status, decided_by FROM voting.polls WHERE title = 'Renew the anchor lease'");
  expect(p.rows[0]).toEqual({ status: "approved", decided_by: "e2e.trustee5" });
  await m.page.context().close();
  await t.page.context().close();
});
