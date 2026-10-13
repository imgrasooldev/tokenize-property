import { expect, test, type Page } from "@playwright/test";
import { bootstrapLink, connect, enrolAndSignIn, enrolLink, pageWithKey, warm } from "./helpers";

/**
 * Real browser (Edge) + virtual FIDO2 key: enrolment from a one-time link, sign-in, step-up,
 * maker-checker between two administrators, a new officer's first sign-in, sign-out.
 */
test.skip(process.env.SCREENSHOTS === "1", "the screenshot run uses the development database");
test.describe.configure({ mode: "serial" });

let db: Awaited<ReturnType<typeof connect>>;
let adminA: Page;
let adminB: Page;

test.beforeAll(async () => {
  db = await connect();
  await warm();
});
test.afterAll(async () => {
  await db.end();
});

async function actions(officerHandle: string): Promise<string[]> {
  const { rows } = await db.su.query<{ action: string }>(
    "SELECT a.action FROM admin.audit a JOIN admin.officers o ON a.actor = o.id::text WHERE o.handle = $1 ORDER BY a.id",
    [officerHandle],
  );
  return rows.map((r) => r.action);
}

test("enrolment from a one-time link, sign-in, step-up and sign-out", async ({ browser }) => {
  const a = await pageWithKey(browser);
  adminA = a.page;
  const link = await bootstrapLink(db.cli, "e2e.admin1", "Ayesha Admin");
  await adminA.goto(link);
  await expect(adminA.getByText("Ayesha Admin")).toBeVisible();
  // The token is removed from the address bar at once (it was only ever in the fragment).
  expect(adminA.url()).not.toContain("token=");
  await adminA.getByRole("button", { name: "Register security key" }).click();
  await expect(adminA.getByTestId("enrol-done")).toBeVisible();
  expect(await a.credentials()).toBe(1);

  // The same link cannot be used twice.
  const again = await pageWithKey(browser);
  await again.page.goto(link);
  await expect(again.page.getByTestId("enrol-error")).toBeVisible();
  await again.page.context().close();

  await adminA.getByRole("link", { name: "Go to sign-in" }).click();
  await adminA.getByRole("button", { name: "Sign in with security key" }).click();
  await adminA.waitForURL(/\/officers$/);
  const cookies = await adminA.context().cookies();
  const session = cookies.find((c) => c.name === "__Host-pt_admin");
  expect(session?.httpOnly).toBe(true);
  expect(session?.secure).toBe(true);
  expect(session?.sameSite).toBe("Strict");

  await adminA.goto("/account");
  await expect(adminA.getByTestId("me-handle")).toHaveText("e2e.admin1");
  // Sign-in counts as a step-up; a new confirmation records another fresh assertion.
  const verified = adminA.waitForResponse((r) => r.url().endsWith("/api/auth/stepup/verify"));
  await adminA.getByRole("button", { name: "Confirm with security key" }).click();
  expect((await verified).status()).toBe(200);
  await expect(adminA.getByTestId("stepup-state")).toContainText("step-up valid until");

  await adminA.getByRole("button", { name: "Sign out" }).click();
  await adminA.waitForURL(/\/login\?bye=1$/);
  await adminA.goto("/account");
  await adminA.waitForURL(/\/login\?next=%2Faccount/);

  expect(await actions("e2e.admin1")).toEqual(
    expect.arrayContaining(["enrol.completed", "login.success", "page.view", "stepup.success", "logout"]),
  );
});

test("maker-checker: one administrator invites, another approves with a step-up; the new officer signs in", async ({ browser }) => {
  // Administrator A signs in again with the same key.
  await adminA.goto("/login");
  await adminA.getByRole("button", { name: "Sign in with security key" }).click();
  await adminA.waitForURL(/\/officers$/);

  const b = await pageWithKey(browser);
  adminB = b.page;
  await enrolAndSignIn(adminB, await bootstrapLink(db.cli, "e2e.admin2", "Bilal Admin"), /\/officers$/);

  // Maker.
  await adminA.goto("/officers");
  await adminA.locator("#kind").selectOption("invite");
  await adminA.locator("#newName").fill("Sana Maker");
  await adminA.locator("#newHandle").fill("e2e.maker");
  await adminA.locator("#role").selectOption("ops_maker");
  await adminA.locator("#reason").fill("New operations maker for the pilot");
  await adminA.getByRole("button", { name: /Request/ }).click();
  await expect(adminA.getByTestId("officers-ok")).toContainText("another administrator must approve");
  // The maker sees no approve button on their own request.
  await expect(adminA.getByRole("button", { name: "Approve with security key" })).toHaveCount(0);

  // Checker: the approval runs a step-up with B's key first.
  await adminB.goto("/officers");
  await adminB.getByPlaceholder("Reason (at least 10 characters)").fill("Checked the onboarding ticket");
  await adminB.getByRole("button", { name: "Approve with security key" }).click();
  await expect(adminB.getByTestId("officers-ok")).toContainText("approved");
  await expect(adminB.getByTestId("officers-table")).toContainText("e2e.maker");
  expect(await actions("e2e.admin2")).toEqual(expect.arrayContaining(["stepup.success", "change.decided", "officer.invited", "role.granted"]));

  // The new officer enrols from a CLI-issued link and lands on the operations overview.
  const m = await pageWithKey(browser);
  await enrolAndSignIn(m.page, await enrolLink(db.cli, "e2e.maker"), /\/$/);
  await expect(m.page.getByRole("heading", { name: "Operations overview" })).toBeVisible();
  // An operations maker cannot open officer management.
  const res = await m.page.goto("/officers");
  expect(res?.status()).toBe(403);
  await expect(m.page.getByTestId("forbidden")).toBeVisible();
  expect(await actions("e2e.maker")).toEqual(expect.arrayContaining(["access.denied"]));
});

test("the admin audit trail shows the ceremonies and its chain is intact", async () => {
  await adminA.goto("/audit/admin");
  await expect(adminA.getByTestId("chain-state")).toHaveText("Intact ✓");
  await expect(adminA.getByTestId("audit-table")).toContainText("login.success");
  const { rows } = await db.su.query("SELECT * FROM admin.verify_audit()");
  expect(rows).toEqual([]);
});
