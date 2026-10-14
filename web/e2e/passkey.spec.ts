import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import pg from "pg";

/**
 * Investor passkeys in a real browser (Edge) with a virtual platform authenticator (CDP WebAuthn:
 * CTAP2, internal transport, resident keys, user verification always succeeds). Runs with
 * playwright.passkey.config.ts against http://localhost:3102 and the throw-away database pt_web_e2e.
 *
 * The first session is opened the way sign-up opens one (webauth.web_start_session, 'signup'), with
 * its token set as the cookie: sign-up itself needs the KYC and signing services, which this run
 * does not start.
 */
test.describe.configure({ mode: "serial" });

const BASE = "http://localhost:3102";
let su: pg.Client;

function adminConfig(): pg.ClientConfig {
  const env = new Map<string, string>();
  // Fixed path inside the repository.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  for (const line of readFileSync(join(process.cwd(), "..", "backend", ".env.local"), "utf8").split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0 && !line.startsWith("#")) env.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return {
    host: env.get("PG_HOST") ?? "127.0.0.1",
    port: Number(env.get("PG_PORT") ?? 5433),
    user: env.get("PG_ADMIN_USER") ?? "pt_admin",
    password: env.get("PG_ADMIN_PASSWORD") ?? "",
    database: "pt_web_e2e",
  };
}

test.beforeAll(async () => {
  su = new pg.Client(adminConfig());
  await su.connect();
});
test.afterAll(async () => {
  await su.end();
});

const sha = (t: string): Buffer => createHash("sha256").update(t, "utf8").digest();

async function newInvestor(name: string): Promise<string> {
  const { rows } = await su.query<{ id: string }>(
    "INSERT INTO webdemo.investors (display_name, wallet_address, kyc_status, onboard_step) VALUES ($1, $2, 'verified', 'done') RETURNING id",
    [name, `0x${randomBytes(20).toString("hex")}`],
  );
  return rows[0]?.id ?? "";
}

async function pageWithAuthenticator(browser: Browser): Promise<{ page: Page; credentials: () => Promise<number> }> {
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { page, credentials: async () => (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials.length };
}

async function auditActions(investorId: string): Promise<string[]> {
  const { rows } = await su.query<{ action: string }>("SELECT action FROM webauth.audit WHERE actor = $1 ORDER BY id", [`web:${investorId}`]);
  return rows.map((r) => r.action);
}

test("on an IP address the sign-in page explains that passkeys need the secure domain", async ({ page }) => {
  await page.goto("http://127.0.0.1:3102/login");
  await expect(page.getByRole("button", { name: "Sign in with passkey" })).toBeDisabled();
  await expect(page.getByTestId("passkey-unavailable")).toContainText("http://localhost:3102");
  // The demo sign-in is still offered.
  await expect(page.getByRole("button", { name: "Continue as Alice" })).toBeVisible();
});

test("register a passkey on /account, sign out, sign in with it, then remove it after a step-up", async ({ browser }) => {
  const { page, credentials } = await pageWithAuthenticator(browser);
  const id = await newInvestor("Edge Passkey");
  const token = randomBytes(32).toString("base64url");
  await su.query("SELECT webauth.web_start_session($1, $2, 'signup')", [sha(token), id]);
  await page.context().addCookies([{ name: "pt_session", value: token, url: BASE }]);

  await page.goto("/account");
  const panel = page.getByTestId("passkey-panel");
  await expect(panel.getByRole("heading", { name: "Passkeys" })).toBeVisible();
  await expect(panel.getByText("You have no passkey yet.")).toBeVisible();
  await panel.getByLabel("Passkey name").fill("Edge laptop");
  await panel.getByRole("button", { name: "Add a passkey" }).click();
  await expect(panel.getByTestId("passkey-done")).toHaveText("Passkey added.");
  await expect(panel.getByTestId("passkey-list")).toContainText("Edge laptop");
  expect(await credentials()).toBe(1);

  // Sign out; the old cookie no longer works.
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await page.waitForURL(`${BASE}/`);
  await page.context().addCookies([{ name: "pt_session", value: token, url: BASE }]);
  await page.goto("/account");
  await page.waitForURL(/\/login$/);

  // Sign in with the passkey (discoverable: nothing typed).
  const signIn = page.getByRole("button", { name: "Sign in with passkey" });
  await expect(signIn).toBeEnabled();
  await signIn.click();
  await page.waitForURL(/\/account$/);
  const cookie = (await page.context().cookies()).find((c) => c.name === "pt_session");
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Strict");
  await expect(page.getByTestId("passkey-list")).toContainText("Used for this session");

  // Removing needs a passkey confirmation within 5 minutes: age it, so the page has to ask again.
  await su.query("ALTER TABLE webauth.sessions DISABLE TRIGGER sessions_guard");
  try {
    await su.query("UPDATE webauth.sessions SET passkey_at = passkey_at - interval '6 minutes' WHERE investor_id = $1 AND ended_at IS NULL", [id]);
  } finally {
    await su.query("ALTER TABLE webauth.sessions ENABLE TRIGGER sessions_guard");
  }
  await page.getByTestId("passkey-panel").getByRole("button", { name: "Remove" }).click();
  await page.getByTestId("passkey-panel").getByRole("button", { name: "Confirm removal" }).click();
  await expect(page.getByTestId("passkey-done")).toHaveText("Passkey removed.");
  await expect(page.getByTestId("passkey-panel").getByText("You have no passkey yet.")).toBeVisible();

  // The authenticator still offers the removed credential; the website refuses it.
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await page.waitForURL(`${BASE}/`);
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in with passkey" }).click();
  await expect(page.getByTestId("passkey-error")).toContainText("not registered here, was removed");

  expect(await auditActions(id)).toEqual(
    expect.arrayContaining(["session.started", "passkey.registered", "logout", "login.success", "stepup.required", "stepup.success", "passkey.revoked", "login.failed"]),
  );
  expect((await su.query("SELECT * FROM webauth.verify_audit()")).rows).toEqual([]);
});
