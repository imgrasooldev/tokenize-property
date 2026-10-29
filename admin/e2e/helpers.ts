import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Browser, Page } from "@playwright/test";
import pg from "pg";
import { adminSettings } from "../scripts/lib-db.mjs";

function e2eDb(): string {
  const line = readFileSync(".env.e2e", "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("ADMIN_PG_DATABASE="));
  return line?.slice("ADMIN_PG_DATABASE=".length) ?? "pt_admin_e2e";
}

/** Superuser connection to the e2e database (assertions) and one dropped to pt_admin_cli (links). */
export async function connect(): Promise<{ su: pg.Client; cli: pg.Client; end: () => Promise<void> }> {
  const su = new pg.Client(adminSettings(e2eDb()));
  const cli = new pg.Client(adminSettings(e2eDb()));
  await su.connect();
  await cli.connect();
  await cli.query("SET ROLE pt_admin_cli");
  return {
    su,
    cli,
    end: async () => {
      await su.end();
      await cli.end();
    },
  };
}

const sha = (t: string) => createHash("sha256").update(t, "utf8").digest();

export async function bootstrapLink(cli: pg.Client, handle: string, name: string): Promise<string> {
  const t = randomBytes(32).toString("base64url");
  await cli.query("SELECT admin.bootstrap_admin($1, $2, $3, 'cli:e2e')", [handle, name, sha(t)]);
  return `/enrol#token=${t}`;
}

export async function enrolLink(cli: pg.Client, handle: string): Promise<string> {
  const t = randomBytes(32).toString("base64url");
  await cli.query("SELECT admin.issue_enrolment($1, $2, 'cli:e2e', 30)", [handle, sha(t)]);
  return `/enrol#token=${t}`;
}

let clients = 0;
/**
 * A page with its own virtual FIDO2 security key (Chrome DevTools Protocol WebAuthn domain):
 * CTAP2 over USB, resident keys, user verification (PIN) always succeeds, presence automatic.
 */
export async function pageWithKey(browser: Browser): Promise<{ page: Page; credentials: () => Promise<number> }> {
  // Each officer's browser is its own client for the per-address ceremony limits (10 enrolments a
  // minute): the e2e server trusts X-Forwarded-For (ADMIN_TRUST_PROXY=1, playwright.config.ts), so a
  // fast run (warm CI cache) does not trip the limit with several officers enrolling from one address.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { "x-forwarded-for": `198.51.100.${String(++clients)}` } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "usb",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return {
    page,
    credentials: async () => (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials.length,
  };
}

export async function enrolAndSignIn(page: Page, link: string, landing: RegExp): Promise<void> {
  await page.goto(link);
  await page.getByRole("button", { name: "Register security key" }).click();
  await page.getByTestId("enrol-done").waitFor();
  await page.getByRole("link", { name: "Go to sign-in" }).click();
  await page.getByRole("button", { name: "Sign in with security key" }).click();
  await page.waitForURL(landing);
}

/** Compiles every route once (Turbopack compiles on first request; that can take tens of seconds). */
export async function warm(): Promise<void> {
  const paths = [
    "/login", "/enrol", "/account", "/officers", "/", "/audit/signer", "/audit/admin", "/approvals", "/compliance", "/trustee",
    "/api/auth/login/options", "/api/auth/login/verify", "/api/auth/enrol/options", "/api/auth/enrol/verify",
    "/api/auth/stepup/options", "/api/auth/stepup/verify", "/api/auth/logout", "/api/officers/changes", "/api/officers/changes/1/decide",
    // Screens of 2026-10-29/30: a route compiled for the first time while a page is open makes the dev server reload it.
    "/support", "/complaints", "/complaints/1", "/operations", "/operations/bank", "/operations/policies", "/documents",
    "/api/complaints/1/act", "/api/operations/bank", "/api/operations/policies", "/api/operations/policies/1/decide", "/api/approvals/hold",
  ];
  for (const p of paths) {
    await fetch(`http://localhost:3301${p}`, { redirect: "manual", signal: AbortSignal.timeout(170_000) }).catch(() => undefined);
  }
}
