import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type pg from "pg";
import { caseOf, freezePolicies, investor, partialHolding } from "../test/support/compliance";
import { connect, enrolAndSignIn, enrolLink, pageWithKey, warm } from "./helpers";

/**
 * The compliance screens of Step 6c (migration 0019) and partial freezes (0054) in a real browser
 * with virtual FIDO2 keys: a possible screening match is approved by two compliance officers; a
 * freeze and a partial freeze are proposed by one and approved by the other (outbox commands, the
 * investor suspended or still verified); an STR case is reviewed, its closure declined by the second
 * officer, exported and recorded as filed. Screenshots go to screenshots/compliance-*.png.
 */
test.skip(process.env.SCREENSHOTS === "1", "the screenshot run uses the development database");
test.describe.configure({ mode: "serial" });

const sha = (t: string) => createHash("sha256").update(t, "utf8").digest();
let db: Awaited<ReturnType<typeof connect>>;
let counter = Date.now();
let links: { comp1: string; comp2: string };
let screening: { subjectId: string; caseId: string };
let held: { subjectId: string; wallet: string };
let partial: { subjectId: string; wallet: string };

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
  const { rows } = await db.su.query<{ id: string }>("SELECT admin.request_change($1, 'invite', NULL, $2, $3, $4, 'officer for the compliance e2e') AS id", [a, role, handle, name]);
  await db.su.query("SELECT admin.decide_change($1, $2, 'approve', 'approved for the compliance e2e')", [b, rows[0]?.id]);
  return enrolLink(db.cli, handle);
}

/** Submits a step-up form with a reason and waits for its own redirect (a previous message may still be on the page). */
async function decide(page: Page, button: string, reason: string, path: RegExp): Promise<void> {
  await page.getByLabel(/Reason \(recorded in the audit chains/).fill(reason);
  const done = page.waitForResponse((r) => path.test(new URL(r.url()).pathname) && r.request().method() === "POST");
  await page.getByRole("button", { name: button }).click();
  await done;
  await page.waitForLoadState("load");
}

const status = async (subjectId: string) => (await db.su.query<{ s: string }>("SELECT kyc.subject_status($1) AS s", [subjectId])).rows[0]?.s;

test.beforeAll(async () => {
  test.setTimeout(900_000); // warming nine pages on a cold dev server
  mkdirSync("screenshots", { recursive: true });
  db = await connect();
  await warm();
  for (const p of ["/enrol", "/compliance", "/compliance/kyc", "/compliance/kyc/1", "/compliance/freezes", "/compliance/freezes/1", "/compliance/partial-freezes/1", "/compliance/str", "/compliance/str/1"]) {
    await fetch(`http://localhost:3301${p}`, { redirect: "manual", signal: AbortSignal.timeout(170_000) }).catch(() => undefined);
  }
  const [a, b] = await admins();
  const n = String(Date.now()).slice(-6);
  links = {
    comp1: await invite(a, b, `e2e.cp1${n}`, "Nadia Compliance", "compliance_officer"),
    comp2: await invite(a, b, `e2e.cp2${n}`, "Omar Compliance", "compliance_officer"),
  };
  await freezePolicies(db.su);
  const s = await investor(db.su, { screening: "review" });
  screening = { subjectId: s.subjectId, caseId: await caseOf(db.su, s.subjectId) };
  held = await investor(db.su);
  partial = await investor(db.su);
  await partialHolding(db.su, partial.wallet, 100);
});
test.afterAll(async () => {
  await db.end();
});

test("two compliance officers: a screening match, a freeze, a partial freeze and an STR case", async ({ browser }) => {
  // One long story (two officers, four flows); a cold dev server compiles every page on first use.
  test.setTimeout(600_000);
  const c1 = await pageWithKey(browser);
  await enrolAndSignIn(c1.page, links.comp1, /\/(recovery|account|compliance)?$/);
  const c2 = await pageWithKey(browser);
  await enrolAndSignIn(c2.page, links.comp2, /\/(recovery|account|compliance)?$/);

  // KYC review: the first officer proposes, the second confirms (C-2).
  await c1.page.goto("/compliance/kyc");
  await expect(c1.page.getByTestId("kyc-queue")).toContainText(`#${screening.caseId}`);
  await c1.page.goto(`/compliance/kyc/${screening.caseId}`);
  await expect(c1.page.getByTestId("checks")).toContainText("sanctions");
  await decide(c1.page, "Approve", "list entry differs in date of birth and city", /\/act$/);
  await expect(c1.page.getByTestId("case-status")).toHaveText("pending second");
  await expect(c1.page.getByTestId("actions-unavailable")).toContainText("Confirm the proposal (second officer)");
  await c1.page.screenshot({ path: "screenshots/compliance-01-kyc-case.png", fullPage: true });
  await c2.page.goto(`/compliance/kyc/${screening.caseId}`);
  await decide(c2.page, "Confirm the proposal (second officer)", "checked the list entry, a different person", /\/act$/);
  await expect(c2.page.getByTestId("case-status")).toHaveText("approved");
  expect(await status(screening.subjectId)).toBe("verified");

  // Freeze: proposed by one officer, approved by the other; the investor reads suspended.
  await c1.page.goto("/compliance/freezes");
  await c1.page.getByLabel("Kind", { exact: true }).selectOption("freeze");
  await c1.page.getByLabel("Wallet", { exact: true }).fill(held.wallet);
  await c1.page.getByLabel("Reason code", { exact: true }).selectOption("court_order");
  await c1.page.getByLabel("Reason", { exact: true }).fill("court order received from the district court");
  await c1.page.getByRole("button", { name: "Propose with security key" }).click();
  await c1.page.waitForURL(/\/compliance\/freezes\/\d+/);
  const freezeId = /\/compliance\/freezes\/(\d+)/.exec(c1.page.url())?.[1] ?? "";
  await expect(c1.page.getByTestId("decision-unavailable")).toContainText("You proposed this freeze");
  await c2.page.goto(`/compliance/freezes/${freezeId}`);
  await decide(c2.page, "Approve with security key", "order checked against the court record", /\/decide$/);
  await expect(c2.page.getByTestId("freeze-status")).toHaveText("approved");
  await expect(c2.page.getByTestId("command")).toContainText("compliance.freeze");
  expect(await status(held.subjectId)).toBe("suspended");

  // Partial freeze: 40 of 100 units; the investor stays verified.
  await c1.page.goto("/compliance/freezes");
  await c1.page.getByLabel("Partial wallet").fill(partial.wallet);
  await c1.page.getByLabel("Units").fill("40");
  await c1.page.getByLabel("Partial reason code").selectOption("reversal_review");
  await c1.page.getByLabel("Partial reason", { exact: true }).fill("subscription may have to be reversed: protective hold");
  await c1.page.getByRole("button", { name: "Propose partial with security key" }).click();
  await c1.page.waitForURL(/\/compliance\/partial-freezes\/\d+/);
  const partialId = /\/compliance\/partial-freezes\/(\d+)/.exec(c1.page.url())?.[1] ?? "";
  await expect(c1.page.getByTestId("partial-amount")).toContainText("40 units");
  await c2.page.goto(`/compliance/partial-freezes/${partialId}`);
  await decide(c2.page, "Approve with security key", "units checked against the subscription", /\/decide$/);
  await expect(c2.page.getByTestId("partial-status")).toHaveText("approved");
  await expect(c2.page.getByTestId("command")).toContainText("compliance.freeze_partial");
  expect(await status(partial.subjectId)).toBe("verified");
  await c2.page.goto("/compliance/freezes");
  await expect(c2.page.getByTestId("partial-holds")).toContainText("40 units");
  await c2.page.screenshot({ path: "screenshots/compliance-02-freezes.png", fullPage: true });

  // STR: open, review, a note; the second officer declines closing; export, then record the filing.
  await c1.page.goto("/compliance/str");
  await c1.page.getByLabel("Category").selectOption("structuring");
  await c1.page.getByLabel("Summary").fill("Several deposits just below the reporting threshold within one week");
  await c1.page.getByRole("button", { name: "Open STR case" }).click();
  await c1.page.waitForURL(/\/compliance\/str\/\d+/);
  const strId = /\/compliance\/str\/(\d+)/.exec(c1.page.url())?.[1] ?? "";
  await expect(c1.page.getByTestId("str-status")).toHaveText("open");
  await decide(c1.page, "Start the review", "statements requested from the trustee bank", /\/act$/);
  await expect(c1.page.getByTestId("str-status")).toHaveText("under review");
  await c1.page.getByRole("textbox", { name: "Note" }).fill("bank statements requested from the trustee bank");
  await c1.page.getByRole("button", { name: "Add note" }).click();
  await expect(c1.page.getByTestId("notes")).toContainText("bank statements requested");
  await decide(c1.page, "Propose closing without a report", "deposits explained by the salary slips", /\/act$/);
  await expect(c1.page.getByTestId("str-status")).toHaveText("close proposed");
  await c2.page.goto(`/compliance/str/${strId}`);
  await decide(c2.page, "Decline closing (second officer)", "the slips do not cover the whole amount", /\/act$/);
  await expect(c2.page.getByTestId("str-status")).toHaveText("under review");
  const download = c2.page.waitForEvent("download");
  await c2.page.getByRole("button", { name: "Export with security key" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.zip$/);
  await c2.page.goto(`/compliance/str/${strId}`);
  await expect(c2.page.getByTestId("exports")).toBeVisible();
  await c2.page.getByLabel("FMU reference").fill("FMU/2026/E2E");
  await decide(c2.page, "Record the FMU filing", "filed with the FMU by hand today", /\/act$/);
  await expect(c2.page.getByTestId("str-status")).toHaveText("filed");
  await c2.page.screenshot({ path: "screenshots/compliance-03-str.png", fullPage: true });

  const cmds = await db.su.query<{ kind: string }>("SELECT kind FROM outbox.commands WHERE idempotency_key = ANY ($1::text[]) ORDER BY kind", [
    [`compliance.freeze:request:${freezeId}`, `compliance.freeze_partial:request:${partialId}`],
  ]);
  expect(cmds.rows.map((r) => r.kind)).toEqual(["compliance.freeze", "compliance.freeze_partial"]);
  await c1.page.context().close();
  await c2.page.context().close();
});
