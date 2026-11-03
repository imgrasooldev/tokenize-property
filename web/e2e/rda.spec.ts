import { expect, test } from "@playwright/test";
import { randomCnic, testDb } from "./helpers";

/**
 * Spec S-08 (migrations 0056, 0057) in a real browser: a Pakistani living in the UAE signs up with a
 * NICOP; the account says "being reviewed" and shows the residency; nothing is registered on chain
 * until two compliance officers approve (here with command-line names, as the backend tests do;
 * PT Control is covered by the admin tests); then the on-chain onboarding runs like any sign-up.
 */
test("a NICOP holder abroad signs up, waits for the review, then is registered on chain", async ({ page }) => {
  test.setTimeout(300_000);
  const cnic = randomCnic();
  await page.goto("/signup");
  await page.getByLabel("Full name (as on CNIC)").fill("Nadia Overseas");
  await page.getByLabel("CNIC number").fill(cnic);
  await page.getByLabel("Mobile number").fill("0300-1234567");
  await page.getByLabel(/I live outside Pakistan/).check();
  await expect(page.getByTestId("abroad-fields")).toBeVisible();
  await page.getByLabel("Identity document").selectOption("nicop");
  await page.getByLabel("Country you live in").selectOption("784");
  await page.getByLabel(/liveness/).check();
  await page.getByLabel(/accept the prototype terms/).check();
  await page.getByRole("button", { name: "Verify and create account" }).click();
  await expect(page).toHaveURL(/\/account$/, { timeout: 90_000 });

  await expect(page.getByTestId("residency")).toContainText("United Arab Emirates");
  await expect(page.getByTestId("account-notice")).toBeVisible();
  const rows = await testDb<{ subject: string; step: string }>(
    "SELECT kyc_subject::text AS subject, onboard_step AS step FROM webdemo.investors WHERE display_name = 'Nadia Overseas' ORDER BY created_at DESC LIMIT 1",
  );
  expect(rows[0]?.step).toBe("waiting");
  const subject = rows[0]?.subject ?? "";
  const review = await testDb<{ id: string }>("SELECT id::text FROM compliance.residency_reviews WHERE subject_id = $1 AND status = 'open'", [subject]);
  await testDb("SELECT compliance.residency_act($1, 'officer:e2e-one', 'propose', 'NICOP and residence permit checked')", [review[0]?.id]);
  await testDb("SELECT compliance.residency_act($1, 'officer:e2e-two', 'confirm', 'documents checked a second time')", [review[0]?.id]);

  // The settlement follower starts the onboarding; the account page then refreshes itself until done.
  await expect
    .poll(async () => (await testDb<{ step: string }>("SELECT onboard_step AS step FROM webdemo.investors WHERE kyc_subject = $1", [subject]))[0]?.step, { timeout: 60_000 })
    .not.toBe("waiting");
  await page.reload();
  await expect(page.locator("dd").filter({ hasText: /^Yes$/ })).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId("account-notice")).toHaveCount(0);
  await expect(page.getByTestId("residency")).toContainText("Roshan Digital Account");
});
