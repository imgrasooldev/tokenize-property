import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type pg from "pg";
import { connect, enrolAndSignIn, enrolLink, pageWithKey, warm } from "./helpers";

/**
 * Transaction monitoring (migration 0051) and health and alerts (migration 0052) in a real browser
 * with virtual FIDO2 keys: a compliance officer proposes dismissing a monitoring alert, a second one
 * confirms; another alert is escalated into an STR case; an operations maker acknowledges a health
 * alert. Screenshots go to screenshots/monitoring-*.png.
 */
test.skip(process.env.SCREENSHOTS === "1", "the screenshot run uses the development database");
test.describe.configure({ mode: "serial" });

const sha = (t: string) => createHash("sha256").update(t, "utf8").digest();
let db: Awaited<ReturnType<typeof connect>>;
let counter = Date.now();
let links: { comp1: string; comp2: string; maker: string };
let alerts: { dismiss: string; escalate: string; health: string };

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
  const { rows } = await db.su.query<{ id: string }>("SELECT admin.request_change($1, 'invite', NULL, $2, $3, $4, 'officer for the monitoring e2e') AS id", [a, role, handle, name]);
  await db.su.query("SELECT admin.decide_change($1, $2, 'approve', 'approved for the monitoring e2e')", [b, rows[0]?.id]);
  return enrolLink(db.cli, handle);
}

/** A monitoring alert as the rules leave it, for a new investor. */
async function tmAlert(summary: string): Promise<string> {
  const s = await db.su.query<{ id: string }>(
    "INSERT INTO kyc.subjects (name_hash, name_enc, pepper_version, cnic_last4, created_by) VALUES ($1, $2, 1, '1357', 'cli:e2e') RETURNING id",
    [randomBytes(32), randomBytes(48)],
  );
  const a = await db.su.query<{ id: string }>(
    `INSERT INTO compliance.tm_alerts (rule, subject_id, window_from, window_to, amount_paisa, evidence, params, summary, opened_by)
     VALUES ('structuring', $1, now() - interval '3 days', now(), 570000000, '[{"kind": "credit", "ref": "RAAST-E2E-1", "amountPaisa": "190000000"}]',
             '{"thresholdPaisa": 200000000, "bandPercent": 80, "minCount": 3, "windowDays": 7}', $2, 'monitor:e2e') RETURNING id`,
    [s.rows[0]?.id, summary],
  );
  return a.rows[0]?.id ?? "";
}

/** Submits a step-up form and waits for its own redirect (a previous message may still be on the page). */
async function decide(page: Page, button: string, reason: string, path: RegExp): Promise<void> {
  await page.getByLabel(/Reason \(recorded in the audit chains/).fill(reason);
  const done = page.waitForResponse((r) => path.test(new URL(r.url()).pathname) && r.request().method() === "POST");
  await page.getByRole("button", { name: button }).click();
  await done;
  await page.waitForLoadState("load");
}

test.beforeAll(async () => {
  mkdirSync("screenshots", { recursive: true });
  db = await connect();
  await warm();
  for (const p of ["/compliance/monitoring", "/compliance/monitoring/1", "/compliance/str/1", "/health"]) {
    await fetch(`http://localhost:3301${p}`, { redirect: "manual", signal: AbortSignal.timeout(170_000) }).catch(() => undefined);
  }
  const [a, b] = await admins();
  const n = String(Date.now()).slice(-6);
  links = {
    comp1: await invite(a, b, `e2e.tm1${n}`, "Sana Compliance", "compliance_officer"),
    comp2: await invite(a, b, `e2e.tm2${n}`, "Hamza Compliance", "compliance_officer"),
    maker: await invite(a, b, `e2e.hm${n}`, "Kamran Operations", "ops_maker"),
  };
  alerts = {
    dismiss: await tmAlert(`3 payments just below the threshold, e2e ${n} A`),
    escalate: await tmAlert(`3 payments just below the threshold, e2e ${n} B`),
    health: (await db.su.query<{ id: string }>("INSERT INTO monitor.alerts (check_key, level, detail) VALUES ($1, 'WARN', 'disk /: 85% used') RETURNING id", [`host:e2e${n}:disk /`])).rows[0]?.id ?? "",
  };
});
test.afterAll(async () => {
  await db.end();
});

test("a monitoring alert is dismissed by two compliance officers and another becomes an STR case", async ({ browser }) => {
  const c1 = await pageWithKey(browser);
  await enrolAndSignIn(c1.page, links.comp1, /\/(recovery|account)?$/);
  await c1.page.goto("/compliance/monitoring");
  await expect(c1.page.getByTestId("tm-open")).toContainText(`#${alerts.dismiss}`);
  await expect(c1.page.getByTestId("tm-rules")).toContainText("placeholder");
  await c1.page.screenshot({ path: "screenshots/monitoring-01-desk.png", fullPage: true });

  await c1.page.goto(`/compliance/monitoring/${alerts.dismiss}`);
  await expect(c1.page.getByTestId("tm-evidence")).toContainText("RAAST-E2E-1");
  await decide(c1.page, "Propose dismissing (no suspicion)", "regular salary payments, checked", /\/act$/);
  await expect(c1.page.getByTestId("tm-status")).toHaveText("dismiss proposed");
  // The proposer cannot confirm: the page says why.
  await expect(c1.page.getByTestId("actions-unavailable")).toContainText("a different compliance officer confirms");

  const c2 = await pageWithKey(browser);
  await enrolAndSignIn(c2.page, links.comp2, /\/(recovery|account)?$/);
  await c2.page.goto(`/compliance/monitoring/${alerts.dismiss}`);
  await decide(c2.page, "Confirm dismissing (second officer)", "payslips seen, agree with the proposal", /\/act$/);
  await expect(c2.page.getByTestId("tm-status")).toHaveText("dismissed");

  await c2.page.goto(`/compliance/monitoring/${alerts.escalate}`);
  await decide(c2.page, "Open an STR case", "no economic reason for splitting the payments", /\/act$/);
  await c2.page.waitForURL(/\/compliance\/str\/\d+/);
  await expect(c2.page.getByTestId("decision-ok")).toContainText(`opened from monitoring alert #${alerts.escalate}`);
  await expect(c2.page.getByTestId("str-status")).toHaveText("open");
  await c2.page.screenshot({ path: "screenshots/monitoring-02-str.png", fullPage: true });

  const rows = await db.su.query<{ id: string; status: string }>("SELECT id::text, status FROM compliance.tm_alerts WHERE id = ANY ($1::bigint[]) ORDER BY id", [[alerts.dismiss, alerts.escalate]]);
  expect(rows.rows.map((r) => r.status)).toEqual(["dismissed", "escalated"]);
  await c1.page.context().close();
  await c2.page.context().close();
});

test("an operations maker sees the health checks and acknowledges an alert", async ({ browser }) => {
  const m = await pageWithKey(browser);
  await enrolAndSignIn(m.page, links.maker, /\/$/);
  await m.page.goto("/health");
  await expect(m.page.getByTestId("health-checks")).toContainText("recon");
  await expect(m.page.getByTestId("health-open")).toContainText("85% used");
  const form = m.page.locator("form", { has: m.page.getByLabel(/Note for host:e2e\d+:disk \//) });
  await form.getByRole("textbox").fill("cleaning old logs now");
  const done = m.page.waitForResponse((r) => /\/api\/health\/\d+\/acknowledge$/.test(new URL(r.url()).pathname) && r.request().method() === "POST");
  await form.getByRole("button", { name: "Acknowledge" }).click();
  await done;
  await m.page.waitForLoadState("load");
  await expect(m.page.getByTestId("decision-ok")).toContainText("Alert acknowledged");
  await m.page.screenshot({ path: "screenshots/monitoring-03-health.png", fullPage: true });
  const a = await db.su.query<{ acknowledged_by: string }>("SELECT acknowledged_by FROM monitor.alerts WHERE id = $1", [alerts.health]);
  expect(a.rows[0]?.acknowledged_by).toMatch(/^e2e\.hm\d+$/);
  await m.page.context().close();
});
