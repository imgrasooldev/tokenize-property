import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type pg from "pg";
import { passRecon } from "../test/support/approvals";
import { investor } from "../test/support/compliance";
import { connect, enrolAndSignIn, enrolLink, pageWithKey, warm } from "./helpers";

/**
 * T-049 platform roles in a real browser with virtual FIDO2 keys: the platform owner places an
 * emergency payout hold from /approvals with a fresh security-key step-up (payouts stop at once), and
 * an investor-support agent looks investors up on /support by the 8-character reference (a verified
 * investor shows as verified; one under review reads only "refer to compliance"; an unknown
 * reference finds nothing). Screenshots go to screenshots/t049-*.png.
 */
test.skip(process.env.SCREENSHOTS === "1", "the screenshot run uses the development database");
test.describe.configure({ mode: "serial" });

const OUT = "screenshots";
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest();
let db: Awaited<ReturnType<typeof connect>>;
let counter = Date.now();
let links: { owner: string; support: string };

async function adminSession(su: pg.Client, handle: string): Promise<Buffer> {
  const cred = await su.query<{ id: string }>("SELECT c.id FROM admin.credentials c JOIN admin.officers o ON o.id = c.officer_id WHERE o.handle = $1", [handle]);
  const t = randomBytes(32).toString("base64url");
  await su.query("SELECT admin.start_session($1, $2, $3)", [sha(t), cred.rows[0]?.id, ++counter]);
  return sha(t);
}

/** Two administrators (from an earlier spec when it ran first; else bootstrapped here with stand-in keys). */
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
  const { rows } = await db.su.query<{ id: string }>("SELECT admin.request_change($1, 'invite', NULL, $2, $3, $4, 'officer for the platform roles e2e') AS id", [a, role, handle, name]);
  await db.su.query("SELECT admin.decide_change($1, $2, 'approve', 'approved for the platform roles e2e')", [b, rows[0]?.id]);
  return enrolLink(db.cli, handle);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${OUT}/t049-${name}.png`, fullPage: true });
}

test.beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  db = await connect();
  await warm();
  for (const p of ["/approvals", "/support"]) {
    await fetch(`http://localhost:3301${p}`, { redirect: "manual", signal: AbortSignal.timeout(170_000) }).catch(() => undefined);
  }
  const [a, b] = await admins();
  links = {
    owner: await invite(a, b, "e2e.owner1", "Nadia Owner", "platform_owner"),
    support: await invite(a, b, "e2e.support1", "Kamran Support", "support_agent"),
  };
});
test.afterAll(async () => {
  await db.end();
});

test("the platform owner holds all payouts with a security-key step-up; payouts stop at once", async ({ browser }) => {
  await passRecon(db.su);
  const gate = async () => (await db.su.query<{ allowed: boolean }>("SELECT allowed FROM recon.payout_gate()")).rows[0]?.allowed;
  expect(await gate()).toBe(true);
  const o = await pageWithKey(browser);
  await enrolAndSignIn(o.page, links.owner, /\/$/);
  await o.page.goto("/approvals");
  await expect(o.page.getByTestId("emergency-hold")).toBeVisible();
  await shot(o.page, "01-hold-form");
  await o.page.getByPlaceholder("Why payouts must stop now (at least 10 characters)").fill("Bank reported a suspicious payout file");
  await o.page.getByRole("button", { name: "Hold all payouts now" }).click();
  await expect(o.page.getByTestId("decision-ok")).toContainText("Payouts are on hold");
  await expect(o.page.getByTestId("emergency-hold")).toHaveCount(0);
  await shot(o.page, "02-held");
  expect(await gate()).toBe(false);
  const e = await db.su.query<{ actor: string }>("SELECT actor FROM recon.gate_events ORDER BY id DESC LIMIT 1");
  expect(e.rows[0]?.actor).toBe("e2e.owner1");
  expect((await db.su.query("SELECT * FROM admin.verify_audit()")).rows).toEqual([]);
  await o.page.context().close();
});

test("investor support finds one investor by reference and never sees why a file is held", async ({ browser }) => {
  const ok = await investor(db.su);
  const held = await investor(db.su, { screening: "review" });
  const ref = (id: string) => id.replace(/-/g, "").slice(0, 8);
  const s = await pageWithKey(browser);
  await enrolAndSignIn(s.page, links.support, /\/support$/);

  await s.page.getByLabel("Reference (8 characters)").fill(ref(ok.subjectId));
  await s.page.getByRole("button", { name: "Look up" }).click();
  await expect(s.page.getByTestId("support-status")).toHaveText("Verified");
  await shot(s.page, "03-support-verified");

  await s.page.getByLabel("Reference (8 characters)").fill(ref(held.subjectId));
  await s.page.getByRole("button", { name: "Look up" }).click();
  await expect(s.page.getByTestId("support-status")).toContainText("Refer to compliance");
  await expect(s.page.getByTestId("support-investor")).not.toContainText(/sanction|pep|screening|review/i);
  await shot(s.page, "04-support-refer");

  await s.page.getByLabel("Reference (8 characters)").fill("00000000");
  await s.page.getByRole("button", { name: "Look up" }).click();
  await expect(s.page.getByTestId("support-none")).toContainText("No investor");

  const lookups = await db.su.query("SELECT 1 FROM admin.audit a JOIN admin.officers o ON a.actor = o.id::text WHERE o.handle = 'e2e.support1' AND a.action = 'support.lookup'");
  expect(lookups.rowCount).toBe(3);
  await s.page.context().close();
});
