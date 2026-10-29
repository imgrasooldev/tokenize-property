import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type pg from "pg";
import { connect, enrolAndSignIn, enrolLink, pageWithKey, warm } from "./helpers";

/**
 * PT Control screens of 2026-10-29/30 in a real browser with virtual FIDO2 keys: a support agent
 * acknowledges and resolves an investor complaint (migration 0040), and an operations maker proposes
 * new signing-policy values that a different checker activates (migration 0039). Each action needs
 * the officer's security key. Screenshots go to screenshots/followups-*.png.
 */
test.skip(process.env.SCREENSHOTS === "1", "the screenshot run uses the development database");
test.describe.configure({ mode: "serial" });

const sha = (t: string) => createHash("sha256").update(t, "utf8").digest();
let db: Awaited<ReturnType<typeof connect>>;
let counter = Date.now();
let links: { support: string; maker: string; checker: string };

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

async function invite(a: Buffer, b: Buffer, handle: string, name: string, role: string): Promise<string> {
  const { rows } = await db.su.query<{ id: string }>("SELECT admin.request_change($1, 'invite', NULL, $2, $3, $4, 'officer for the follow-ups e2e') AS id", [a, role, handle, name]);
  await db.su.query("SELECT admin.decide_change($1, $2, 'approve', 'approved for the follow-ups e2e')", [b, rows[0]?.id]);
  return enrolLink(db.cli, handle);
}

/** Submits a step-up form and waits for its own redirect (a previous message may still be on the page). */
async function submit(page: Page, button: string, path: RegExp, within: Locator | Page = page): Promise<void> {
  const done = page.waitForResponse((r) => path.test(new URL(r.url()).pathname) && r.request().method() === "POST");
  await within.getByRole("button", { name: button }).click();
  await done;
  await page.waitForLoadState("load");
}

test.beforeAll(async () => {
  mkdirSync("screenshots", { recursive: true });
  db = await connect();
  await warm();
  for (const p of ["/complaints", "/operations/policies"]) {
    await fetch(`http://localhost:3301${p}`, { redirect: "manual", signal: AbortSignal.timeout(170_000) }).catch(() => undefined);
  }
  const [a, b] = await admins();
  links = {
    support: await invite(a, b, "e2e.support2", "Iqra Support", "support_agent"),
    maker: await invite(a, b, "e2e.maker3", "Faisal Maker", "ops_maker"),
    checker: await invite(a, b, "e2e.checker4", "Nida Checker", "ops_checker"),
  };
});
test.afterAll(async () => {
  await db.end();
});

test("a support agent acknowledges and resolves an investor complaint with security-key step-ups", async ({ browser }) => {
  // An investor files on the website (session-bound function, as the website calls it).
  const inv = await db.su.query<{ id: string }>("INSERT INTO webdemo.investors (display_name, wallet_address, kyc_status) VALUES ('E2E Investor', $1, 'verified') RETURNING id", [
    `0x${randomBytes(20).toString("hex")}`,
  ]);
  const t = randomBytes(32).toString("base64url");
  await db.su.query("SELECT webauth.web_start_session($1, $2, 'signup')", [sha(t), inv.rows[0]?.id]);
  const filed = (await db.su.query<{ r: { id: number; ref: string } }>("SELECT complaints.web_file($1, 'payout', 'Rent not received', 'My rent for September has not arrived.') AS r", [sha(t)])).rows[0]?.r;

  const s = await pageWithKey(browser);
  await enrolAndSignIn(s.page, links.support, /\/support$/);
  await s.page.goto("/complaints");
  await expect(s.page.getByTestId("complaints")).toContainText(filed?.ref ?? "CMP-");
  await s.page.goto(`/complaints/${String(filed?.id)}`);
  await s.page.getByLabel(/Message to the investor/).fill("We are checking with the bank today.");
  await submit(s.page, "Acknowledge", /\/api\/complaints\/\d+\/act$/);
  await expect(s.page.getByTestId("complaint-status")).toHaveText("acknowledged");
  await s.page.getByLabel(/Message to the investor/).fill("The bank returned it; it was sent again on 30 October.");
  await submit(s.page, "Resolve (message = resolution)", /\/api\/complaints\/\d+\/act$/);
  await expect(s.page.getByTestId("complaint-status")).toHaveText("resolved");
  await s.page.screenshot({ path: "screenshots/followups-01-complaint.png", fullPage: true });
  const seen = (await db.su.query<{ c: { status: string } }>("SELECT complaints.web_case($1, $2) AS c", [sha(t), filed?.id])).rows[0]?.c;
  expect(seen?.status).toBe("resolved");
  await s.page.context().close();
});

test("an operations maker proposes new policy values; a different checker activates them", async ({ browser }) => {
  const kind = `e2e.policy${randomBytes(2).toString("hex")}`;
  const p0 = await db.su.query<{ id: string }>("SELECT signer.propose_policy($1, $2::jsonb, 'cli:maker') AS id", [kind, JSON.stringify({ chainId: 586586, maxPerDay: "100" })]);
  await db.su.query("SELECT signer.approve_policy($1, 'cli:checker')", [p0.rows[0]?.id]);

  const m = await pageWithKey(browser);
  await enrolAndSignIn(m.page, links.maker, /\/$/);
  await m.page.goto("/operations/policies");
  const mine = m.page.locator("section").filter({ has: m.page.getByRole("heading", { name: kind }) });
  await mine.getByLabel("New values (same fields)").fill(JSON.stringify({ chainId: 586586, maxPerDay: "250" }));
  await submit(m.page, "Propose (a checker activates)", /\/api\/operations\/policies$/, mine);
  await expect(m.page.getByTestId("decision-ok")).toContainText("proposal");

  const c = await pageWithKey(browser);
  await enrolAndSignIn(c.page, links.checker, /\/$/);
  await c.page.goto("/operations/policies");
  const proposal = c.page.locator("section").filter({ has: c.page.getByRole("heading", { name: kind }) });
  await submit(c.page, "Activate with security key", /\/api\/operations\/policies\/\d+\/decide$/, proposal);
  await expect(c.page.getByTestId("decision-ok")).toContainText("Restart the signing service");
  await c.page.screenshot({ path: "screenshots/followups-02-policy.png", fullPage: true });
  const active = await db.su.query<{ rule: { maxPerDay: string }; approved_by: string }>(
    "SELECT rule, approved_by FROM signer.policies WHERE kind = $1 AND approved_at IS NOT NULL AND retired_at IS NULL",
    [kind],
  );
  expect(active.rows[0]).toMatchObject({ rule: { maxPerDay: "250" }, approved_by: "e2e.checker4" });
  await m.page.context().close();
  await c.page.context().close();
});
