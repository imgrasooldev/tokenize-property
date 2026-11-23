import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type pg from "pg";
import { investor } from "../test/support/compliance";
import { connect, enrolAndSignIn, enrolLink, pageWithKey, warm } from "./helpers";

/**
 * Residency reviews of non-resident investors (spec S-08, migration 0056) in a real browser with
 * virtual FIDO2 keys: a NICOP holder living abroad reads "review" until a second compliance officer
 * confirms the first one's proposal; the proposer cannot confirm their own proposal; a second
 * investor's review is rejected, which keeps that investor out of "verified". Screenshots go to
 * screenshots/residency-*.png.
 */
test.skip(process.env.SCREENSHOTS === "1", "the screenshot run uses the development database");
test.describe.configure({ mode: "serial" });

const sha = (t: string) => createHash("sha256").update(t, "utf8").digest();
let db: Awaited<ReturnType<typeof connect>>;
let counter = Date.now();
let links: { comp1: string; comp2: string };
let abroad: { subjectId: string; review: string };
let refused: { subjectId: string; review: string };

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

async function invite(a: Buffer, b: Buffer, handle: string, name: string): Promise<string> {
  const { rows } = await db.su.query<{ id: string }>("SELECT admin.request_change($1, 'invite', NULL, 'compliance_officer', $2, $3, 'officer for the residency e2e') AS id", [a, handle, name]);
  await db.su.query("SELECT admin.decide_change($1, $2, 'approve', 'approved for the residency e2e')", [b, rows[0]?.id]);
  return enrolLink(db.cli, handle);
}

/** A verified investor who then records a NICOP and a country of residence abroad: a residency review opens. */
async function nonResident(country: number): Promise<{ subjectId: string; review: string }> {
  const inv = await investor(db.su);
  await db.su.query("SELECT kyc.record_residency($1, 'non_resident', 'nicop', $2::smallint, 'kyc-service')", [inv.subjectId, country]);
  const { rows } = await db.su.query<{ id: string }>("SELECT id::text FROM compliance.residency_reviews WHERE subject_id = $1 AND status = 'open'", [inv.subjectId]);
  return { subjectId: inv.subjectId, review: rows[0]?.id ?? "" };
}

/** Submits a step-up form with a reason and waits for its own redirect. */
async function decide(page: Page, button: string, reason: string): Promise<void> {
  await page.getByLabel(/Reason \(recorded in the audit chains/).fill(reason);
  const done = page.waitForResponse((r) => /\/act$/.test(new URL(r.url()).pathname) && r.request().method() === "POST");
  await page.getByRole("button", { name: button }).click();
  await done;
  await page.waitForLoadState("load");
}

const status = async (subjectId: string) => (await db.su.query<{ s: string }>("SELECT kyc.subject_status($1) AS s", [subjectId])).rows[0]?.s;

test.beforeAll(async () => {
  test.setTimeout(600_000); // warming the pages on a cold dev server
  mkdirSync("screenshots", { recursive: true });
  db = await connect();
  await warm();
  for (const p of ["/enrol", "/compliance", "/compliance/residency", "/compliance/residency/1"]) {
    await fetch(`http://localhost:3301${p}`, { redirect: "manual", signal: AbortSignal.timeout(170_000) }).catch(() => undefined);
  }
  const [a, b] = await admins();
  const n = String(Date.now()).slice(-6);
  links = { comp1: await invite(a, b, `e2e.rd1${n}`, "Rabia Compliance"), comp2: await invite(a, b, `e2e.rd2${n}`, "Saad Compliance") };
  abroad = await nonResident(826);
  refused = await nonResident(784);
});
test.afterAll(async () => {
  await db.end();
});

test("two compliance officers approve a residency review; a rejected review keeps the investor out", async ({ browser }) => {
  test.setTimeout(600_000);
  expect(abroad.review).not.toBe("");
  expect(await status(abroad.subjectId)).toBe("review");
  const c1 = await pageWithKey(browser);
  await enrolAndSignIn(c1.page, links.comp1, /\/(recovery|account|compliance)?$/);
  const c2 = await pageWithKey(browser);
  await enrolAndSignIn(c2.page, links.comp2, /\/(recovery|account|compliance)?$/);

  // The list shows the open review with the document and the country.
  await c1.page.goto("/compliance/residency");
  await expect(c1.page.getByTestId("residency-reviews")).toContainText(`#${abroad.review}`);
  await expect(c1.page.getByTestId("residency-reviews")).toContainText("NICOP");

  // The first officer proposes; they cannot confirm their own proposal.
  await c1.page.goto(`/compliance/residency/${abroad.review}`);
  await expect(c1.page.getByTestId("residency-country")).not.toBeEmpty();
  await decide(c1.page, "Propose approval", "NICOP and overseas address checked against the documents");
  await expect(c1.page.getByTestId("residency-status")).toHaveText("proposed");
  await expect(c1.page.getByTestId("actions-unavailable")).toContainText("Confirm the proposal (second officer)");
  expect(await status(abroad.subjectId)).toBe("review");
  await c1.page.screenshot({ path: "screenshots/residency-01-proposed.png", fullPage: true });

  // The second officer confirms: the investor is verified.
  await c2.page.goto(`/compliance/residency/${abroad.review}`);
  await decide(c2.page, "Confirm the proposal (second officer)", "second check of the NICOP and the residence");
  await expect(c2.page.getByTestId("residency-status")).toHaveText("approved");
  expect(await status(abroad.subjectId)).toBe("verified");

  // Another review is rejected: the investor does not become verified.
  await c2.page.goto(`/compliance/residency/${refused.review}`);
  await decide(c2.page, "Reject", "documents do not show residence abroad");
  await expect(c2.page.getByTestId("residency-status")).toHaveText("rejected");
  expect(await status(refused.subjectId)).not.toBe("verified");
  await c2.page.screenshot({ path: "screenshots/residency-02-rejected.png", fullPage: true });
});
