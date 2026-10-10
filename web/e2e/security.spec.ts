import { expect, test } from "@playwright/test";

test("security headers on every page", async ({ request }) => {
  for (const path of ["/", "/login", "/market", "/properties/GPF3"]) {
    const res = await request.get(path);
    expect(res.status()).toBe(200);
    const h = res.headers();
    expect(h["content-security-policy"]).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(h["content-security-policy"]).toContain("connect-src 'self'");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBe("no-referrer");
    expect(h["x-powered-by"]).toBeUndefined();
  }
});

test("a forged or tampered session cookie is not accepted", async ({ page, context }) => {
  for (const value of [
    "3f1c2b7e-9d4a-4c1e-8f2a-1b2c3d4e5f60.9999999999.forged",
    "not-a-session",
    "3f1c2b7e-9d4a-4c1e-8f2a-1b2c3d4e5f60.1.AAAA",
  ]) {
    await context.clearCookies();
    await context.addCookies([{ name: "pt_session", value, url: "http://127.0.0.1:3101" }]);
    await page.goto("/portfolio");
    await expect(page).toHaveURL(/\/login$/);
  }
});

test("unknown properties and feeds are 404, private pages need sign-in", async ({ page, request }) => {
  expect((await request.get("/api/market/NOPE/stream")).status()).toBe(404);
  const res = await page.goto("/properties/..%2F..%2Fetc");
  expect(res?.status()).toBe(404);
  await expect(page.getByText("This page does not exist.")).toBeVisible();
  for (const path of ["/portfolio", "/account"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
  }
});

test("the live market feed streams public data only", async ({ page }) => {
  await page.goto("/market");
  const frame = await page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const es = new EventSource("/api/market/GPF3/stream");
        es.addEventListener("market", (e) => {
          es.close();
          resolve((e as MessageEvent<string>).data);
        });
        setTimeout(() => {
          es.close();
          reject(new Error("no market frame"));
        }, 15_000);
      }),
  );
  const view = JSON.parse(frame) as Record<string, unknown>;
  expect(Object.keys(view).sort()).toEqual(["asks", "bids", "candles", "last", "trades", "version", "volume24h"]);
  // No investor ids, wallets or names in the public feed.
  expect(frame).not.toMatch(/investor|wallet|display_name|buyer|seller/i);
});
