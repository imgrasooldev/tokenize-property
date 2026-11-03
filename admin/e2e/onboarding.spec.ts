import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type pg from "pg";
import { connect, enrolAndSignIn, enrolLink, pageWithKey, warm } from "./helpers";

/**
 * PT Control onboarding desk (migration 0049) and goAML values (migration 0050) in a real browser
 * with virtual FIDO2 keys: an operations maker with the S-01 onboarding duty finds a sponsor file on
 * the desk, records the registration check with a security-key step-up and is refused a risk rating
 * (compliance duty); a compliance officer replaces a goAML placeholder. Screenshots go to
 * screenshots/onboarding-*.png.
 */
test.skip(process.env.SCREENSHOTS === "1", "the screenshot run uses the development database");
test.describe.configure({ mode: "serial" });

const sha = (t: string) => createHash("sha256").update(t, "utf8").digest();
let db: Awaited<ReturnType<typeof connect>>;
let counter = Date.now();
let links: { maker: string; compliance: string };
let makerHandle: string;
let sponsorId: string;
let cuinLast4: string;

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
  const { rows } = await db.su.query<{ id: string }>("SELECT admin.request_change($1, 'invite', NULL, $2, $3, $4, 'officer for the onboarding e2e') AS id", [a, role, handle, name]);
  await db.su.query("SELECT admin.decide_change($1, $2, 'approve', 'approved for the onboarding e2e')", [b, rows[0]?.id]);
  return enrolLink(db.cli, handle);
}

/** An active S-01 duty: asked by one administrator, approved by the other (once per handle). */
async function duty(handle: string, name: string): Promise<void> {
  const live = await db.su.query("SELECT 1 FROM property.staff_duties WHERE actor = $1 AND duty = $2 AND status = 'active'", [handle, name]);
  if (live.rowCount) return;
  const { rows } = await db.su.query<{ id: string }>("SELECT property.request_duty($1, $2, 'e2e.admin1', 'duty for the onboarding e2e') AS id", [handle, name]);
  await db.su.query("SELECT property.decide_duty($1, 'e2e.admin2', true, 'approved for the onboarding e2e')", [rows[0]?.id]);
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
  for (const p of ["/onboarding", `/onboarding/sponsor/${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`, "/compliance/str"]) {
    await fetch(`http://localhost:3301${p}`, { redirect: "manual", signal: AbortSignal.timeout(170_000) }).catch(() => undefined);
  }
  const [a, b] = await admins();
  const n = String(Date.now()).slice(-6);
  makerHandle = `e2e.onb${n}`;
  links = {
    maker: await invite(a, b, makerHandle, "Usman Onboarding", "ops_maker"),
    compliance: await invite(a, b, `e2e.comp${n}`, "Maryam Compliance", "compliance_officer"),
  };
  // A company sponsor as createSponsor leaves it; the sealed name and address are opaque to the portal.
  cuinLast4 = n.slice(-4);
  const s = await db.su.query<{ id: string }>(
    "INSERT INTO property.sponsors (id, kind, legal_name_enc, address_enc, pepper_version, cuin_last4, created_by) VALUES (gen_random_uuid(), 'company', $1, $2, 1, $3, 'cli:e2e') RETURNING id",
    [randomBytes(64), randomBytes(96), cuinLast4],
  );
  sponsorId = s.rows[0]?.id ?? "";
});
test.afterAll(async () => {
  await db.end();
});

test("an onboarding maker records the registration check with a step-up and is refused a risk rating", async ({ browser }) => {
  const m = await pageWithKey(browser);
  await enrolAndSignIn(m.page, links.maker, /\/$/);
  // A duty goes only to an active officer, so after the enrolment.
  await duty(makerHandle, "onboarding");
  await m.page.goto("/onboarding");
  await expect(m.page.getByRole("note")).toContainText("onboarding");
  const sponsors = m.page.getByTestId("onboarding-sponsors");
  await expect(sponsors).toContainText(`CUIN …${cuinLast4}`);
  await m.page.screenshot({ path: "screenshots/onboarding-01-desk.png", fullPage: true });

  await sponsors.getByRole("link", { name: `Company · CUIN …${cuinLast4}` }).click();
  await m.page.waitForURL(`**/onboarding/sponsor/${sponsorId}`);
  await expect(m.page.getByTestId("sponsor-state")).toHaveText("kyb_draft");

  const check = m.page.getByTestId("act-registration_check");
  await check.locator("summary").click();
  await check.getByLabel("Method").selectOption("secp_eservices");
  await check.getByLabel("Outcome").selectOption("verified");
  await check.locator("input[name=evidence]").fill(randomBytes(32).toString("hex"));
  await submit(m.page, "Record the registration check with security key", /\/api\/onboarding\/act$/, check);
  await expect(m.page.getByTestId("decision-ok")).toContainText("Done");
  await expect(m.page.locator("section", { has: m.page.getByRole("heading", { name: "KYB evidence" }) })).toContainText("verified (secp_eservices");

  // A risk rating needs the compliance duty: the database refuses and the page says why.
  const risk = m.page.getByTestId("act-risk");
  await risk.locator("summary").click();
  await risk.getByLabel("Rating").selectOption("low");
  await risk.getByLabel("Reasons").fill("listed group, simple ownership");
  await submit(m.page, "Rate the risk with security key", /\/api\/onboarding\/act$/, risk);
  await expect(m.page.getByTestId("decision-error")).toContainText("compliance");
  await m.page.screenshot({ path: "screenshots/onboarding-02-refused.png", fullPage: true });

  const checks = await db.su.query<{ outcome: string }>("SELECT outcome FROM property.registration_checks WHERE sponsor_id = $1", [sponsorId]);
  expect(checks.rows.map((r) => r.outcome)).toEqual(["verified"]);
  await m.page.context().close();
});

test("a compliance officer replaces a goAML placeholder with a security-key step-up", async ({ browser }) => {
  const c = await pageWithKey(browser);
  await enrolAndSignIn(c.page, links.compliance, /\/(recovery|account)?$/);
  await c.page.goto("/compliance/str");
  const goaml = c.page.getByTestId("goaml");
  await expect(goaml).toContainText("rentity_branch");

  const branch = `Gulberg branch ${randomBytes(2).toString("hex")}`;
  await goaml.locator("#goaml-target").selectOption("setting:rentity_branch");
  await goaml.locator("#goaml-value").fill(branch);
  await goaml.locator("#goaml-reason").fill("confirmed by the FMU registration letter");
  await submit(c.page, "Save with security key", /\/api\/compliance\/goaml$/, goaml);
  await expect(c.page.getByTestId("decision-ok")).toContainText("goAML value saved");
  await expect(c.page.getByTestId("goaml")).toContainText(branch);
  await c.page.screenshot({ path: "screenshots/onboarding-03-goaml.png", fullPage: true });

  const saved = await db.su.query<{ value: string; placeholder: boolean }>("SELECT value, placeholder FROM compliance.goaml_settings WHERE key = 'rentity_branch'");
  expect(saved.rows[0]).toMatchObject({ value: branch, placeholder: false });
  await c.page.context().close();
});
