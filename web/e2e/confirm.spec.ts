import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { loginAs, testDb } from "./helpers";

/**
 * ADR 0018 amendment 1 (migration 0060) on the website: a reservation the mobile app asked for is
 * shown only to its own investor at /confirm and can be declined there. Confirming runs the existing
 * reserve form (covered by its own tests and backend/packages/offering/test/app-requests.test.ts);
 * the request is inserted directly here because the e2e database has no live offering.
 */
const letters = "BCDFGHJKLMNPQRSTVWXZ";
const code = (): string => Array.from(randomBytes(8), (b) => letters.charAt(b % letters.length)).join("");

test("an unknown code is refused; the investor's own app request can be declined", async ({ page }) => {
  test.setTimeout(180_000);
  await loginAs(page, "Alice");
  await page.goto("/confirm?code=BCDF-GHJK");
  await expect(page.getByRole("alert")).toContainText("unknown, expired or not yours");

  const offering = await testDb<{ id: string }>("SELECT id FROM offering.offerings ORDER BY created_at LIMIT 1");
  const alice = await testDb<{ id: string }>("SELECT id FROM webdemo.investors WHERE display_name LIKE 'Alice%' ORDER BY created_at LIMIT 1");
  test.skip(!offering[0] || !alice[0], "the e2e database has no offering to attach a request to");
  const c = code();
  await testDb(
    `INSERT INTO papi.requests (investor_id, kind, offering_id, units, idempotency_key, code, created_at, expires_at)
     SELECT $1, 'reserve', $2, 10, $3, $4, t, t + interval '15 minutes' FROM (SELECT date_trunc('microseconds', clock_timestamp()) AS t) x`,
    [alice[0]?.id, offering[0]?.id, `e2e-${randomBytes(6).toString("hex")}`, c],
  );
  // Bob never sees Alice's request.
  await loginAs(page, "Bob");
  await page.goto(`/confirm?code=${c}`);
  await expect(page.getByRole("alert")).toContainText("unknown, expired or not yours");

  await loginAs(page, "Alice");
  await page.goto(`/confirm?code=${c.slice(0, 4)}-${c.slice(4)}`);
  await expect(page.getByTestId("confirm-request")).toContainText("10");
  await page.getByRole("button", { name: "I did not ask for this" }).click();
  await expect(page.getByTestId("confirm-status")).toContainText("Declined");
  const row = await testDb<{ status: string }>("SELECT status FROM papi.requests WHERE code = $1", [c]);
  expect(row[0]?.status).toBe("declined");
});

/**
 * ADR 0018 amendment 3 (migration 0062): a market order the app asked for is placed by the website's
 * own checks when the investor confirms it; outside the price band it is refused and nothing is placed.
 */
test("an app order request is placed only through the website's checks and then bound to the request", async ({ page }) => {
  test.setTimeout(300_000);
  const alice = await testDb<{ id: string }>("SELECT id FROM webdemo.investors WHERE display_name LIKE 'Alice%' ORDER BY created_at LIMIT 1");
  test.skip(!alice[0], "no Alice in the e2e database");
  const insert = async (price: number): Promise<string> => {
    const c = code();
    await testDb(
      `INSERT INTO papi.requests (investor_id, kind, units, idempotency_key, code, created_at, expires_at, symbol, side, price_paisa)
       SELECT $1, 'order', 10, $2, $3, t, t + interval '15 minutes', 'GPF3', 'sell', $4 FROM (SELECT date_trunc('microseconds', clock_timestamp()) AS t) x`,
      [alice[0]?.id, `e2e-${randomBytes(6).toString("hex")}`, c, price],
    );
    return c;
  };
  await loginAs(page, "Alice");
  const outside = await insert(10_000);
  await page.goto(`/confirm?code=${outside}`);
  await expect(page.getByTestId("confirm-request")).toContainText("GPF3");
  await page.getByRole("button", { name: "Place this order" }).click();
  await expect(page.getByTestId("app-order").getByRole("alert")).toContainText("must be between", { timeout: 60_000 });
  expect((await testDb<{ status: string }>("SELECT status FROM papi.requests WHERE code = $1", [outside]))[0]?.status).toBe("pending");
  await page.getByRole("button", { name: "I did not ask for this" }).click();
  await expect(page.getByTestId("confirm-status")).toContainText("Declined");

  // At the top of the band (Rs 549): far above any bid the other specs leave, so it rests in the book.
  const inside = await insert(54_900);
  await page.goto(`/confirm?code=${inside}`);
  await page.getByRole("button", { name: "Place this order" }).click();
  await expect(page.getByTestId("confirm-status")).toContainText("Order placed", { timeout: 60_000 });
  const row = await testDb<{ status: string; order_id: string | null }>("SELECT status, order_id FROM papi.requests WHERE code = $1", [inside]);
  expect(row[0]?.status).toBe("confirmed");
  const placed = await testDb<{ side: string; price_paisa: string }>("SELECT side, price_paisa::text FROM webdemo.orders WHERE id = $1", [row[0]?.order_id]);
  expect(placed[0]).toEqual({ side: "sell", price_paisa: "54900" });
  // Leave the book as the other specs expect it (a sell order holds no cash in escrow).
  await testDb("UPDATE webdemo.orders SET status = 'cancelled', note = 'e2e cleanup' WHERE id = $1 AND status = 'open'", [row[0]?.order_id]);
});

/**
 * ADR 0018 amendment 4 (migration 0063): cancelling an open order the app asked for runs the
 * website's own cancellation; the request is confirmed only once the order really is cancelled.
 */
test("an app request to cancel an open order cancels it through the website", async ({ page }) => {
  test.setTimeout(180_000);
  const alice = await testDb<{ id: string }>("SELECT id FROM webdemo.investors WHERE display_name LIKE 'Alice%' ORDER BY created_at LIMIT 1");
  test.skip(!alice[0], "no Alice in the e2e database");
  // A resting sell order (no cash in escrow), far above any bid the other specs leave.
  const order = await testDb<{ id: string }>(
    "INSERT INTO webdemo.orders (id, request_id, investor_id, symbol, side, price_paisa, tokens, status) VALUES (gen_random_uuid(), gen_random_uuid(), $1, 'GPF3', 'sell', 54900, 3, 'open') RETURNING id",
    [alice[0]?.id],
  );
  const c = code();
  await testDb(
    `INSERT INTO papi.requests (investor_id, kind, units, idempotency_key, code, created_at, expires_at, symbol, side, price_paisa, target_order)
     SELECT $1, 'order_cancel', 3, $2, $3, t, t + interval '15 minutes', 'GPF3', 'sell', 54900, $4 FROM (SELECT date_trunc('microseconds', clock_timestamp()) AS t) x`,
    [alice[0]?.id, `e2e-${randomBytes(6).toString("hex")}`, c, order[0]?.id],
  );
  await loginAs(page, "Alice");
  await page.goto(`/confirm?code=${c}`);
  await expect(page.getByTestId("confirm-request")).toContainText("GPF3");
  await page.getByTestId("cancel-app-order").click();
  await expect(page.getByTestId("confirm-status")).toContainText("Order cancelled", { timeout: 60_000 });
  expect((await testDb<{ status: string }>("SELECT status FROM webdemo.orders WHERE id = $1", [order[0]?.id]))[0]?.status).toBe("cancelled");
  expect((await testDb<{ status: string; order_id: string | null }>("SELECT status, order_id FROM papi.requests WHERE code = $1", [c]))[0]).toEqual({
    status: "confirmed",
    order_id: order[0]?.id,
  });
});
