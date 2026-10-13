import { expect, test } from "@playwright/test";
import { loginAs, randomCnic, testDb } from "./helpers";

test("sign-up: NADRA failure, KYC service + on-chain onboarding through the outbox, duplicate CNIC refused", async ({ page }) => {
  // Four on-chain steps through the outbox and the signing service (ADR 0010), on a dev server
  // that may still be compiling pages: more than the default 2 minutes.
  test.setTimeout(300_000);
  const cnic = randomCnic();
  const fill = async (c: string) => {
    await page.goto("/signup");
    await page.getByLabel("Full name (as on CNIC)").fill("Ayesha Endtoend");
    await page.getByLabel("CNIC number").fill(c);
    await page.getByLabel("Mobile number").fill("0300-1234567");
    await page.getByLabel(/liveness/).check();
    await page.getByLabel(/accept the prototype terms/).check();
    await page.getByRole("button", { name: "Verify and create account" }).click();
  };

  await fill(`${cnic.slice(0, -1)}0`);
  await expect(page.locator(".alert:not(.demo)")).toContainText("NADRA could not verify");

  await fill(cnic);
  await expect(page).toHaveURL(/\/account$/, { timeout: 90_000 });
  // Registration runs through the outbox and the signing service; the page refreshes itself until done.
  await expect(page.getByText("Verified on chain")).toBeVisible();
  await expect(page.locator("dd").filter({ hasText: /^Yes$/ })).toBeVisible({ timeout: 120_000 });

  // Data minimisation: the full CNIC is stored nowhere.
  const digits = cnic.replaceAll("-", "");
  const hits = await testDb<{ n: string }>(
    "SELECT count(*) AS n FROM webdemo.investors WHERE row_to_json(investors)::text LIKE $1",
    [`%${digits}%`],
  );
  expect(hits[0]?.n).toBe("0");
  // Nor by the KYC service (peppered hashes and the last four digits only, ADR 0009).
  const kycHits = await testDb<{ n: string }>("SELECT count(*) AS n FROM kyc.subjects s WHERE row_to_json(s)::text LIKE $1", [`%${digits}%`]);
  expect(kycHits[0]?.n).toBe("0");

  await page.context().clearCookies();
  await fill(cnic);
  await expect(page.locator(".alert:not(.demo)")).toContainText("already exists");
});

test("invest: payment, real mint, portfolio reconciliation and rent self-verification", async ({ page }) => {
  test.setTimeout(300_000); // the mint settles asynchronously (outbox, signing service, chain index)
  await loginAs(page, "Alice");
  await page.goto("/properties/GPF3");
  await page.getByLabel("Number of tokens").fill("20");

  // Without confirming the payment nothing happens.
  await page.getByRole("button", { name: "Pay and invest" }).click();
  await expect(page.locator(".alert:not(.demo)")).toContainText("confirm the payment");

  await page.getByLabel(/confirm the Raast payment/).check();
  await page.getByRole("button", { name: "Pay and invest" }).click();
  await expect(page).toHaveURL(/\/portfolio\?sub=/, { timeout: 90_000 });
  // Minted through the outbox and the signing service; settled once the chain index shows it.
  await expect(page.getByRole("status").filter({ hasText: "Done: 20 GPF3 tokens" })).toBeVisible({ timeout: 90_000 });

  const checks = page.locator(".steps-list").first().locator("li");
  await expect(checks).toHaveCount(4);
  for (const li of await checks.all()) await expect(li.locator(".chip")).toHaveText("✓");

  const verify = page.getByRole("button", { name: "Verify my share on chain" }).first();
  if (await verify.isVisible()) {
    await verify.click();
    const result = page.locator("form.verify ul li");
    await expect(result).toHaveCount(3);
    for (const li of await result.all()) await expect(li.locator(".chip")).toHaveText("✓");
  }
});
