import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type pg from "pg";
import { freezePayouts, passRecon, pendingMint, type TestSigner } from "../test/support/approvals";
import { connect, enrolAndSignIn, enrolLink, pageWithKey, warm } from "./helpers";

/**
 * Step 6b in a real browser (Edge) with virtual FIDO2 keys: two operations checkers approve a mint
 * that the signing service holds for maker-checker (each approval needs a fresh security-key
 * assertion; the second checker cannot be the first); an operations maker asks for an unfreeze and
 * a checker approves it once reconciliation passed. Screenshots go to screenshots/6b-*.png.
 */
test.skip(process.env.SCREENSHOTS === "1", "the screenshot run uses the development database");
test.describe.configure({ mode: "serial" });

const OUT = "screenshots";
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest();
let db: Awaited<ReturnType<typeof connect>>;
let counter = Date.now();

function e2eEnv(): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of readFileSync(".env.e2e", "utf8").split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0 && !line.startsWith("#")) m.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return m;
}
const signer: TestSigner = {
  url: "http://127.0.0.1:4997",
  adminSecret: "",
  outboxSecret: e2eEnv().get("SIGNER_CLIENT_SECRET_OUTBOX") ?? "",
  stop: () => undefined,
  log: () => "",
};

/** A database session for an administrator (setup only; the WebAuthn ceremony is not the subject here). */
async function adminSession(su: pg.Client, handle: string): Promise<Buffer> {
  const cred = await su.query<{ id: string }>("SELECT c.id FROM admin.credentials c JOIN admin.officers o ON o.id = c.officer_id WHERE o.handle = $1", [handle]);
  const t = randomBytes(32).toString("base64url");
  await su.query("SELECT admin.start_session($1, $2, $3)", [sha(t), cred.rows[0]?.id, ++counter]);
  return sha(t);
}

/** Two administrators (from auth.spec when it ran first; else bootstrapped here with stand-in keys). */
async function admins(): Promise<[Buffer, Buffer]> {
  const have = await db.su.query("SELECT 1 FROM admin.officers WHERE handle IN ('e2e.admin1', 'e2e.admin2') AND status = 'active'");
  if (have.rowCount !== 2) {
    for (const [handle, name] of [["e2e.admin1", "Ayesha Admin"], ["e2e.admin2", "Bilal Admin"]] as const) {
      const link = randomBytes(32).toString("base64url");
      await db.cli.query("SELECT admin.bootstrap_admin($1, $2, $3, 'cli:e2e')", [handle, name, sha(link)]);
      await db.su.query("SELECT admin.complete_enrolment($1, $2, $3, 0, '{usb}', '00000000-0000-0000-0000-000000000000', 'packed', 'singleDevice', false, true)", [
        sha(link),
        randomBytes(20).toString("base64url"),
        randomBytes(77),
      ]);
    }
  }
  return [await adminSession(db.su, "e2e.admin1"), await adminSession(db.su, "e2e.admin2")];
}

/** Invitation approved by two administrators (maker-checker), then a one-time enrolment link. */
async function invite(a: Buffer, b: Buffer, handle: string, name: string, role: string): Promise<string> {
  const { rows } = await db.su.query<{ id: string }>("SELECT admin.request_change($1, 'invite', NULL, $2, $3, $4, 'officer for the approvals e2e') AS id", [a, role, handle, name]);
  await db.su.query("SELECT admin.decide_change($1, $2, 'approve', 'approved for the approvals e2e')", [b, rows[0]?.id]);
  return enrolLink(db.cli, handle);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${OUT}/6b-${name}.png`, fullPage: true });
}

let links: { checker1: string; checker2: string; maker: string };

test.beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  db = await connect();
  await warm();
  for (const p of ["/approvals/signer/00000000-0000-4000-8000-000000000000", "/approvals/unfreeze/1", "/approvals/payouts/1", "/approvals/property", "/approvals/property/1"]) {
    await fetch(`http://localhost:3301${p}`, { redirect: "manual", signal: AbortSignal.timeout(170_000) }).catch(() => undefined);
  }
  const [a, b] = await admins();
  links = {
    checker1: await invite(a, b, "e2e.checker1", "Hina Checker", "ops_checker"),
    checker2: await invite(a, b, "e2e.checker2", "Omar Checker", "ops_checker"),
    maker: await invite(a, b, "e2e.maker2", "Sana Maker", "ops_maker"),
  };
});
test.afterAll(async () => {
  await db.end();
});

test("two checkers approve a mint with their security keys; the signing service decides", async ({ browser }) => {
  const requestId = await pendingMint(signer, "25000");
  const c1 = await pageWithKey(browser);
  await enrolAndSignIn(c1.page, links.checker1, /\/$/);

  await c1.page.goto("/approvals");
  await expect(c1.page.getByTestId("inbox-signer")).toContainText("Mint 25,000 tokens");
  await shot(c1.page, "01-inbox");
  await c1.page.goto(`/approvals/signer/${requestId}`);
  // Exactly what will be signed, decoded from the bytes the signing service builds.
  await expect(c1.page.getByTestId("call-function")).toHaveText("mint(address, uint256, bytes32)");
  await expect(c1.page.getByTestId("arg-amount")).toHaveText("25000");
  await expect(c1.page.getByTestId("call-hash")).toHaveText(/^[0-9a-f]{64}$/);
  await expect(c1.page.getByTestId("live-checks")).toContainText("policy checks pass");
  await shot(c1.page, "02-signer-request");

  const stepups = () => db.su.query("SELECT 1 FROM admin.audit a JOIN admin.officers o ON a.actor = o.id::text WHERE o.handle = 'e2e.checker1' AND a.action = 'stepup.success'");
  const before = (await stepups()).rowCount ?? 0;
  await c1.page.getByPlaceholder("Reason (at least 10 characters)").fill("Payment and amount match the subscription");
  await c1.page.getByRole("button", { name: "Approve with security key" }).click();
  await expect(c1.page.getByTestId("decision-ok")).toContainText("pending_approval");
  // The approval ran a fresh step-up with the checker's key.
  expect((await stepups()).rowCount ?? 0).toBeGreaterThan(before);
  // The same checker cannot give the second approval: the page says why.
  await expect(c1.page.getByTestId("decision-unavailable")).toContainText("different officer");
  await shot(c1.page, "03-after-first-approval");

  const c2 = await pageWithKey(browser);
  await enrolAndSignIn(c2.page, links.checker2, /\/$/);
  await c2.page.goto(`/approvals/signer/${requestId}`);
  await c2.page.getByPlaceholder("Reason (at least 10 characters)").fill("Trustee confirmed the subscription");
  await c2.page.getByRole("button", { name: "Approve with security key" }).click();
  await expect(c2.page.getByTestId("decision-ok")).toContainText("approved");
  await expect(c2.page.getByTestId("signer-status")).toHaveText("approved");
  await shot(c2.page, "04-approved");

  const r = await db.su.query<{ status: string }>("SELECT status FROM signer.requests WHERE id = $1", [requestId]);
  expect(r.rows[0]?.status).toBe("approved");
  const ops = await db.su.query<{ operator: string }>("SELECT operator FROM signer.approvals WHERE request_id = $1 ORDER BY at", [requestId]);
  expect(ops.rows.map((x) => x.operator)).toEqual(["e2e.checker1", "e2e.checker2"]);
  expect((await db.su.query("SELECT * FROM admin.verify_audit()")).rows).toEqual([]);
  expect((await db.su.query("SELECT * FROM signer.verify_audit()")).rows).toEqual([]);
  await c1.page.context().close();
  await c2.page.context().close();
});

test("a maker asks for an unfreeze; a checker approves it after a passed reconciliation run", async ({ browser }) => {
  await freezePayouts(db.su);
  const m = await pageWithKey(browser);
  await enrolAndSignIn(m.page, links.maker, /\/$/);
  await m.page.goto("/approvals");
  await m.page.getByPlaceholder("Why payouts can resume (at least 10 characters)").fill("Late bank file explains the cash difference");
  await m.page.getByRole("button", { name: "Request unfreeze (a checker decides)" }).click();
  await expect(m.page.getByTestId("decision-ok")).toContainText("Unfreeze requested");
  await expect(m.page.getByTestId("decision-unavailable")).toContainText("operations checker");
  const unfreezeUrl = m.page.url().split("?")[0] ?? "";

  // The first test's checkers kept their keys in closed browser contexts: a new checker enrols.
  const c = await pageWithKey(browser);
  const [a, b] = await admins();
  await enrolAndSignIn(c.page, await invite(a, b, "e2e.checker3", "Zara Checker", "ops_checker"), /\/$/);
  await c.page.goto(new URL(unfreezeUrl).pathname);
  await expect(c.page.getByTestId("approve-unavailable")).toContainText("passed after run");
  await expect(c.page.getByRole("button", { name: "Approve with security key" })).toBeDisabled();
  await shot(c.page, "05-unfreeze-blocked");
  await passRecon(db.su);
  await c.page.reload();
  await c.page.getByPlaceholder("Reason (at least 10 characters)").fill("Run passed after the late bank file import");
  await c.page.getByRole("button", { name: "Approve with security key" }).click();
  await expect(c.page.getByTestId("decision-ok")).toContainText("approved");
  await expect(c.page.getByTestId("unfreeze-status")).toHaveText("approved");
  await shot(c.page, "06-unfreeze-approved");
  const gate = await db.su.query<{ allowed: boolean }>("SELECT allowed FROM recon.payout_gate()");
  expect(gate.rows[0]?.allowed).toBe(true);
  await m.page.context().close();
  await c.page.context().close();
});
