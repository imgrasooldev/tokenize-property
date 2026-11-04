import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { loginAs, testDb } from "./helpers";

/**
 * ADR 0018 (migration 0058) on the website: the investor approves the code the mobile app shows
 * (OAuth 2.0 Device Authorization Grant), then sees the device on /account and signs it out. The
 * app's side (polling, tokens, reads) is covered by backend/packages/public-api/test/api.test.ts;
 * here the grant and the first poll are made directly in the test database.
 */
const sha = (b: Buffer) => createHash("sha256").update(b).digest();

test("approve a mobile app code, see the device, sign it out", async ({ page }) => {
  test.setTimeout(180_000);
  const device = randomBytes(32);
  const letters = "BCDFGHJKLMNPQRSTVWXZ";
  const raw = Array.from(randomBytes(8), (b) => letters.charAt(b % letters.length)).join("");
  await testDb("SELECT papi.device_authorize($1, $2, 'pt-mobile', 'E2E Phone')", [sha(device), raw]);

  await loginAs(page, "Alice");
  await page.goto(`/device?code=${raw.slice(0, 4)}-${raw.slice(4)}`);
  await page.getByRole("button", { name: "Approve this device" }).click();
  await expect(page.getByTestId("device-result")).toContainText("E2E Phone is now signed in");

  const r = await testDb<{ r: string }>("SELECT papi.device_token($1, $2, $3) AS r", [sha(device), sha(randomBytes(32)), sha(randomBytes(32))]);
  expect(r[0]?.r).toBe("ok");
  await page.goto("/account");
  const devices = page.getByTestId("devices");
  await expect(devices).toContainText("E2E Phone");
  await devices.locator("li", { hasText: "E2E Phone" }).getByRole("button", { name: "Sign out this device" }).first().click();
  await expect(devices.locator("li", { hasText: "E2E Phone" })).toHaveCount(0);
});
