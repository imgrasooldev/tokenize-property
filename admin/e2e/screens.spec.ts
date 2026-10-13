import { expect, test, type Page } from "@playwright/test";
import { bootstrapLink, connect, enrolAndSignIn, enrolLink, pageWithKey, warm } from "./helpers";

/**
 * Screenshots at 1440 px of every page with REAL data from the local development database
 * (pt_admin_dev, indexed from the local chain). Run on demand only:
 *   ADMIN_E2E_DB=pt_admin_dev SCREENSHOTS=1 npm run test:e2e -- screens
 * Creates demo officers in pt_admin_dev through the normal bootstrap, maker-checker and link steps.
 */
test.skip(process.env.SCREENSHOTS !== "1", "screenshots run on demand only");
test.describe.configure({ mode: "serial" });

const OUT = "screenshots";

async function shot(page: Page, name: string, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}

test("screens", async ({ browser }) => {
  test.setTimeout(900_000);
  const db = await connect();
  await warm();
  try {
    const login = await pageWithKey(browser);
    await login.page.goto("/login");
    await login.page.screenshot({ path: `${OUT}/01-login.png` });

    // Two bootstrap administrators (the first may already exist from `npm run officer -- bootstrap`).
    const a = await pageWithKey(browser);
    const exists = (await db.su.query("SELECT 1 FROM admin.officers WHERE handle = 'demo.admin1'")).rowCount === 1;
    const linkA = exists ? await enrolLink(db.cli, "demo.admin1") : await bootstrapLink(db.cli, "demo.admin1", "Demo Admin One");
    await a.page.goto(linkA);
    await expect(a.page.getByRole("button", { name: "Register security key" })).toBeEnabled();
    await a.page.screenshot({ path: `${OUT}/02-enrol.png` });
    await a.page.getByRole("button", { name: "Register security key" }).click();
    await a.page.getByTestId("enrol-done").waitFor();
    await a.page.getByRole("link", { name: "Go to sign-in" }).click();
    await a.page.getByRole("button", { name: "Sign in with security key" }).click();
    await a.page.waitForURL(/\/officers$/);

    const b = await pageWithKey(browser);
    await enrolAndSignIn(b.page, await bootstrapLink(db.cli, "demo.admin2", "Demo Admin Two"), /\/officers$/);

    async function inviteViaUi(handle: string, name: string, role: string): Promise<void> {
      await a.page.goto("/officers");
      await a.page.locator("#kind").selectOption("invite");
      await a.page.locator("#newName").fill(name);
      await a.page.locator("#newHandle").fill(handle);
      await a.page.locator("#role").selectOption(role);
      await a.page.locator("#reason").fill(`Demo ${role} for the screenshots`);
      await a.page.getByRole("button", { name: /Request/ }).click();
      await expect(a.page.getByTestId("officers-ok")).toBeVisible();
    }
    await inviteViaUi("demo.auditor", "Demo Auditor", "auditor");
    await inviteViaUi("demo.maker", "Demo Maker", "ops_maker");
    await inviteViaUi("demo.trustee", "Demo Trustee", "trustee_officer");
    // Approve one change at a time and wait for its own result (a stale "ok" banner must not count).
    async function approve(handle: string): Promise<void> {
      const { rows } = await db.su.query<{ id: string }>("SELECT id FROM admin.changes WHERE new_handle = $1 AND status = 'open'", [handle]);
      const id = rows[0]?.id ?? "";
      await b.page.goto("/officers");
      const card = b.page.getByTestId(`change-${id}`);
      await card.getByPlaceholder("Reason (at least 10 characters)").fill("Checked the onboarding ticket");
      await card.getByRole("button", { name: "Approve with security key" }).click();
      // The decision is checked in the database (the dev server may re-render the page meanwhile).
      await expect
        .poll(async () => (await db.su.query<{ status: string }>("SELECT status FROM admin.changes WHERE id = $1", [id])).rows[0]?.status, {
          timeout: 60_000,
        })
        .toBe("approved");
    }
    await approve("demo.maker");
    await approve("demo.trustee");
    // One request still open: the checker's view.
    await shot(b.page, "07-officers-checker", "/officers");
    await approve("demo.auditor");

    const aud = await pageWithKey(browser);
    await enrolAndSignIn(aud.page, await enrolLink(db.cli, "demo.auditor"), /\/$/);
    await shot(aud.page, "03-overview", "/");
    await shot(aud.page, "04-audit-signer", "/audit/signer");
    await shot(aud.page, "05-audit-recon", "/audit/recon");
    await shot(aud.page, "05b-audit-ledger", "/audit/ledger");
    await shot(aud.page, "06-audit-admin", "/audit/admin");
    await shot(aud.page, "08-officers-auditor", "/officers");
    await shot(aud.page, "09-compliance-6c", "/compliance");
    await shot(aud.page, "10-trustee-6d", "/trustee");
    await shot(aud.page, "11-account", "/account");

    const mk = await pageWithKey(browser);
    await enrolAndSignIn(mk.page, await enrolLink(db.cli, "demo.maker"), /\/$/);
    await shot(mk.page, "12-approvals-6b", "/approvals");
    const res = await mk.page.goto("/officers");
    expect(res?.status()).toBe(403);
    await mk.page.screenshot({ path: `${OUT}/13-forbidden.png` });

    // Tablet width (responsive check).
    await aud.page.setViewportSize({ width: 820, height: 1100 });
    await shot(aud.page, "14-overview-tablet-820", "/");
  } finally {
    await db.end();
  }
});
