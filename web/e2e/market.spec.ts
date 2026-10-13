import { expect, test, type Page } from "@playwright/test";
import { loginAs, testDb } from "./helpers";

async function order(page: Page, side: "Buy" | "Sell", price: string, tokens: string) {
  await page.getByRole("button", { name: side, exact: true }).click();
  await page.getByLabel("Limit price per token (Rs)").fill(price);
  await page.getByLabel("Number of tokens").fill(tokens);
  await page.getByRole("button", { name: side === "Buy" ? "Place buy order" : "Place sell order" }).click();
}

test.beforeAll(async () => {
  // Earlier test runs may have left orders in the test database; start from an empty book.
  await testDb("UPDATE webdemo.orders SET status = 'cancelled', note = 'e2e reset' WHERE status = 'open'");
});

test("a trade between two investors settles on chain and appears live for others", async ({ page, browser }) => {
  // Since Step 5h delivery runs asynchronously (outbox, signing service, chain index), and a cold
  // dev server compiles each page on first visit: more time than the default 2 minutes.
  test.setTimeout(300_000);
  // An observer watches the public market page; it must update without a reload.
  const observer = await browser.newPage();
  await observer.goto("/market");
  await expect(observer.locator(".market-head .chip")).toContainText("Live");

  await loginAs(page, "Alice");
  await page.goto("/market");
  await order(page, "Sell", "451.25", "10");
  await expect(page.getByRole("status").filter({ hasText: "Order placed" })).toBeVisible({ timeout: 60_000 });

  await loginAs(page, "Bob");
  await page.goto("/market");
  await page.getByLabel("Top-up amount (Rs)").fill("100000");
  await page.getByLabel(/confirm the Raast payment/).check();
  await page.getByRole("button", { name: "Add cash" }).click();
  // The action finished (button back to its label) without an error.
  await expect(page.getByRole("button", { name: "Add cash" })).toBeVisible({ timeout: 90_000 });
  await expect(page.locator(".alert:not(.demo)")).toHaveCount(0);

  // Outside the ±10% band: refused, nothing reserved.
  await order(page, "Buy", "600", "10");
  await expect(page.locator(".alert:not(.demo)")).toContainText("must be between");

  await order(page, "Buy", "460", "10");
  await expect(page.getByRole("status").filter({ hasText: "Order placed" })).toBeVisible({ timeout: 60_000 });
  const myTrades = page.locator("h2", { hasText: "My trades" }).locator("xpath=following-sibling::div[1]");
  await expect(myTrades.locator("tbody tr").first()).toContainText("Bought");
  await expect(myTrades.locator("tbody tr").first()).toContainText("451.25");
  // Delivered through the outbox and the signing service; the page refreshes until it settles.
  await expect(myTrades.locator("tbody tr").first()).toContainText("Settled", { timeout: 90_000 });

  // The observer saw the trade arrive over the live feed.
  await expect(observer.locator(".market-head .stat .value").first()).toHaveText(/451\.25/, { timeout: 15_000 });

  const rows = await testDb<{ status: string; transfer_tx: string | null }>(
    "SELECT status, transfer_tx FROM webdemo.trades WHERE price_paisa = 45125 ORDER BY created_at DESC LIMIT 1",
  );
  expect(rows[0]?.status).toBe("settled");
  expect(rows[0]?.transfer_tx).toMatch(/^0x[0-9a-f]{64}$/);
  await observer.close();
});

test("cancelling an open buy order returns its escrow", async ({ page }) => {
  await loginAs(page, "Bob");
  await page.goto("/market");
  await order(page, "Buy", "450", "10");
  await expect(page.getByRole("status").filter({ hasText: "Order placed" })).toBeVisible({ timeout: 60_000 });
  const openRow = page.locator("tr", { hasText: "Open" }).filter({ has: page.getByRole("button", { name: "Cancel" }) }).first();
  await openRow.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("tr", { hasText: "Open" }).getByRole("button", { name: "Cancel" })).toHaveCount(0);

  await page.goto("/portfolio");
  const checks = page.locator(".steps-list").first().locator("li");
  for (const li of await checks.all()) await expect(li.locator(".chip")).toHaveText("✓");
});
