import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { keccak256, toBytes } from "viem";
import { loginAs, testDb } from "./helpers";

/**
 * S-07 public verification page in a real browser, against the test database's read model of the
 * local chain. Two sample public notices are recorded in the DocumentRegistry first (idempotent,
 * local Ops Safe dev key, `python chain/document.py`), version 2 superseding version 1.
 */
const ROOT = join(process.cwd(), "..");
const FIXTURES = join(process.cwd(), "e2e", "fixtures");
// Fixed fixture paths inside the repository.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const V1 = readFileSync(join(FIXTURES, "sample-notice-v1.txt"));
// eslint-disable-next-line security/detect-non-literal-fs-filename
const V2 = readFileSync(join(FIXTURES, "sample-notice-v2.txt"));
const TAMPERED = Buffer.concat([V2, Buffer.from(" ")]);
const sha = (b: Buffer) => `0x${createHash("sha256").update(b).digest("hex")}`;

/** The anchor test vector shared with contracts/test/AnchorDeployment.t.sol and @pt/anchor's unit test. */
const VECTOR = {
  besuBlockHash: keccak256(toBytes("besu-block-1800")),
  commitment: "0xd37e43dfa7699fa914302afe3161b28b7802f869ee6bad9fc27f5532706e6906",
};

function documentTool(args: string[]): Record<string, unknown> {
  const r = spawnSync("python", [join(ROOT, "chain", "document.py"), ...args], { cwd: ROOT, encoding: "utf8", timeout: 120_000, windowsHide: true });
  if (r.status !== 0) throw new Error(`chain/document.py ${args[0] ?? ""} failed: ${(r.stderr || r.stdout).slice(-400)}`);
  const last = r.stdout.trim().split(/\r?\n/).at(-1) ?? "{}";
  return JSON.parse(last) as Record<string, unknown>;
}

let v1Id = "";
let v2Id = "";

test.beforeAll(() => {
  v1Id = String(documentTool(["add", join(FIXTURES, "sample-notice-v1.txt"), "--uri", "pt-doc://sample-notice-v1"]).id);
  v2Id = String(documentTool(["add", join(FIXTURES, "sample-notice-v2.txt"), "--uri", "pt-doc://sample-notice-v2"]).id);
  documentTool(["supersede", v1Id, v2Id]);
});

/** Reloads until the test indexer shows both records (a few blocks after they were sent). */
async function openWithDocuments(page: Page): Promise<void> {
  await expect(async () => {
    await page.goto("/verify");
    await expect(page.locator(`[data-testid=documents] tr[data-doc="${v2Id}"]`)).toBeVisible({ timeout: 2_000 });
    await expect(page.locator(`[data-testid=documents] tr[data-doc="${v1Id}"]`)).toContainText(`#${v2Id}`, { timeout: 2_000 });
  }).toPass({ timeout: 90_000 });
}

test("public without sign-in: supply as of a block, documents, file hashes checked locally and never uploaded", async ({ page }) => {
  test.setTimeout(240_000);
  await page.context().clearCookies();
  await openWithDocuments(page);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Verify");
  await expect(page.locator("[data-gate]")).toHaveAttribute("data-gate", /^(ok|stale)$/);
  await expect(page.locator("[data-gate]")).toContainText(/block #\d+/);
  await expect(page.getByTestId("total-supply")).toHaveText(/^[\d,]+$/);
  await expect(page.locator("[data-register]")).toHaveAttribute("data-register", "not-published");

  // Nothing leaves the browser while files are checked (acceptance 1).
  const sent: string[] = [];
  page.on("request", (r) => {
    sent.push(`${r.method()} ${r.url()} ${r.postData() ?? ""}`);
  });
  const input = page.locator("#file-check input[type=file]");
  const result = page.locator("#file-check [data-result]");

  await input.setInputFiles({ name: "notice-v2.txt", mimeType: "text/plain", buffer: V2 });
  await expect(result).toHaveAttribute("data-result", "current");
  await expect(page.getByTestId("file-hash")).toHaveText(sha(V2));

  await input.setInputFiles({ name: "notice-v1.txt", mimeType: "text/plain", buffer: V1 });
  await expect(result).toHaveAttribute("data-result", "superseded");
  await expect(result).toContainText(`#${v2Id}`);

  await input.setInputFiles({ name: "notice-tampered.txt", mimeType: "text/plain", buffer: TAMPERED });
  await expect(result).toHaveAttribute("data-result", "none");
  await expect(page.getByTestId("file-hash")).toHaveText(sha(TAMPERED));

  const marker = "SAMPLE PUBLIC NOTICE";
  expect(sent.filter((s) => s.includes(marker) || s.startsWith("POST")), sent.join("\n")).toEqual([]);
});

test("anchors: honest state on this server, and the browser recomputes a commitment (match and tampered)", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/verify");
  // No public anchor chain on this machine, or no read grant: said so, never sample data.
  const state = page.locator("[data-anchor-state]");
  if ((await state.count()) > 0) await expect(state).toHaveAttribute("data-anchor-state", /^(not-configured|no-access)$/);

  // The fixed vector shared with contracts/test/AnchorDeployment.t.sol and @pt/anchor.
  const form = page.locator("#anchor-check");
  await form.getByLabel("besuChainId").fill("586586");
  await form.getByLabel("besuBlock", { exact: true }).fill("1800");
  await form.getByLabel("besuBlockHash").fill(VECTOR.besuBlockHash);
  await form.getByLabel("ledgerJournalId").fill("42");
  await form.getByLabel("ledgerHeadHash").fill(sha(Buffer.from("ledger-head-42")));
  await form.getByLabel("Value on the public chain").fill(VECTOR.commitment);
  await form.getByRole("button", { name: "Recompute" }).click();
  await expect(form.locator("[data-result]")).toHaveAttribute("data-result", "match");

  await form.getByLabel("ledgerJournalId").fill("43");
  await form.getByRole("button", { name: "Recompute" }).click();
  await expect(form.locator("[data-result]")).toHaveAttribute("data-result", "mismatch");
});

test("an investor's entitlement verifies in the browser and on chain; 1 paisa more fails both", async ({ page }) => {
  test.setTimeout(180_000);
  let entitlement = "";
  for (const who of ["Alice", "Bob"] as const) {
    await loginAs(page, who);
    await page.goto("/portfolio#rent");
    const box = page.locator("textarea.entitlement-text").first();
    if ((await box.count()) > 0) {
      entitlement = await box.inputValue();
      break;
    }
  }
  test.skip(entitlement === "", "no published rent statement with a demo persona's entitlement (run python chain/rent.py)");

  // The check itself is public: sign out first.
  await page.context().clearCookies();
  await page.goto("/verify#entitlement");
  const form = page.locator("#entitlement");
  const check = async (text: string) => {
    await form.getByLabel("Entitlement (JSON)").fill(text);
    await form.getByRole("button", { name: "Verify" }).click();
    await expect(form.locator("[data-check=chain]")).toBeVisible({ timeout: 30_000 });
  };
  const tick = (name: string) => form.locator(`[data-check=${name}] .chip`);

  await check(entitlement);
  for (const n of ["local", "local-control", "chain", "chain-control"]) await expect(tick(n)).toHaveText("✓");

  const parsed = JSON.parse(entitlement) as { amountPaisa: string };
  const plusOne = JSON.stringify({ ...JSON.parse(entitlement), amountPaisa: (BigInt(parsed.amountPaisa) + 1n).toString() });
  await check(plusOne);
  await expect(tick("local")).toHaveText("✗");
  await expect(tick("chain")).toHaveText("✗");
});

for (const lang of ["en", "ur"] as const) {
  test(`phone width (375 px) without sideways scrolling and desktop (1440 px), ${lang}`, async ({ page, context }) => {
    await context.clearCookies();
    await context.addCookies([{ name: "lang", value: lang, url: "http://127.0.0.1:3101" }]);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/verify");
    await expect(page.locator("html")).toHaveAttribute("dir", lang === "ur" ? "rtl" : "ltr");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await page.screenshot({ path: `test-results/verify-375-${lang}.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/verify");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
    await page.screenshot({ path: `test-results/verify-1440-${lang}.png`, fullPage: true });
  });
}

test("no personal data in the public page (acceptance 5)", async ({ request }) => {
  const html = (await (await request.get("/verify")).text()).toLowerCase();
  const holders = await testDb<{ holder: string }>("SELECT holder FROM chain.holdings WHERE balance > 0");
  for (const h of holders) expect(html).not.toContain(h.holder.slice(2));
  const names = await testDb<{ display_name: string }>("SELECT display_name FROM webdemo.investors");
  for (const n of names) expect(html).not.toContain(n.display_name.toLowerCase());
  // No CNIC-shaped numbers (00000-0000000-0) or phone numbers.
  expect(html).not.toMatch(/\b\d{5}-\d{7}-\d\b/);
  expect(html).not.toMatch(/\b03\d{2}-?\d{7}\b/);
});
