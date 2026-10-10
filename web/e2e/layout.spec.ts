import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers";

const PAGES = ["/", "/market", "/properties/GPF3", "/portfolio", "/account"];

for (const lang of ["en", "ur"] as const) {
  test(`phone width (375 px) without sideways scrolling, ${lang}`, async ({ page, context }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginAs(page, "Bob");
    await context.addCookies([{ name: "lang", value: lang, url: "http://127.0.0.1:3101" }]);
    for (const path of PAGES) {
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("dir", lang === "ur" ? "rtl" : "ltr");
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width, path).toBeLessThanOrEqual(375);
    }
  });
}

test("language toggle switches to Urdu, right to left", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/");
  await page.getByRole("button", { name: "اردو", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "ur");
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
});
