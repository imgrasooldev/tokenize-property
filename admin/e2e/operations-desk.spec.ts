import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type pg from "pg";
import { connect, enrolAndSignIn, enrolLink, pageWithKey, warm } from "./helpers";

/**
 * PT Control operations desk (migrations 0037-0039) in a real browser with virtual FIDO2 keys: an
 * operations maker uploads a bank statement file on /operations/bank with a security-key step-up
 * (the same file again is the same statement), and the signing policies page lists every kind with
 * its active rule. Screenshots go to screenshots/desk-*.png.
 */
test.skip(process.env.SCREENSHOTS === "1", "the screenshot run uses the development database");
test.describe.configure({ mode: "serial" });

const sha = (t: string) => createHash("sha256").update(t, "utf8").digest();
let db: Awaited<ReturnType<typeof connect>>;
let counter = Date.now();
let makerLink = "";

async function adminSession(su: pg.Client, handle: string): Promise<Buffer> {
  const cred = await su.query<{ id: string }>("SELECT c.id FROM admin.credentials c JOIN admin.officers o ON o.id = c.officer_id WHERE o.handle = $1", [handle]);
  const t = randomBytes(32).toString("base64url");
  await su.query("SELECT admin.start_session($1, $2, $3)", [sha(t), cred.rows[0]?.id, ++counter]);
  return sha(t);
}

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

test.beforeAll(async () => {
  mkdirSync("screenshots", { recursive: true });
  db = await connect();
  await warm();
  for (const p of ["/operations/bank", "/operations/policies"]) {
    await fetch(`http://localhost:3301${p}`, { redirect: "manual", signal: AbortSignal.timeout(170_000) }).catch(() => undefined);
  }
  const [a, b] = await admins();
  const { rows } = await db.su.query<{ id: string }>("SELECT admin.request_change($1, 'invite', NULL, 'ops_maker', 'e2e.desk1', 'Rafay Desk', 'officer for the desk e2e') AS id", [a]);
  await db.su.query("SELECT admin.decide_change($1, $2, 'approve', 'approved for the desk e2e')", [b, rows[0]?.id]);
  makerLink = await enrolLink(db.cli, "e2e.desk1");
});
test.afterAll(async () => {
  await db.end();
});

test("an operations maker imports a bank statement file with a security-key step-up; the same file is the same statement", async ({ browser }) => {
  const account = `E2E-DESK-${randomBytes(3).toString("hex").toUpperCase()}`;
  await db.su.query("SELECT ledger.open_account($1, 'asset', 'PKR')", [`bank:${account.toLowerCase()}`]);
  await db.su.query("SELECT recon.register_bank_account($1, $2, 'test:setup')", [account, `bank:${account.toLowerCase()}`]);
  const file = [
    { type: "header", format: "pt-mock-bank-v1", account, currency: "PKR", statementDate: "2026-10-21", openingPaisa: "0", closingPaisa: "700000" },
    { type: "line", valueDate: "2026-10-21", amountPaisa: "700000", reference: "RAAST-E2E-DESK-01", counterparty: "Tenant (e2e)", balancePaisa: "700000" },
    { type: "trailer", lineCount: 1 },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n");
  const m = await pageWithKey(browser);
  await enrolAndSignIn(m.page, makerLink, /\/$/);
  await m.page.goto("/operations/bank");
  const upload = async () => {
    await m.page.getByLabel("Statement file (.jsonl)").setInputFiles({ name: "statement.jsonl", mimeType: "application/json", buffer: Buffer.from(file) });
    await m.page.getByRole("button", { name: "Import with security key" }).click();
    await expect(m.page.getByTestId("decision-ok")).toContainText("imported");
  };
  await upload();
  await expect(m.page.getByTestId("bank-statements")).toContainText(account);
  await m.page.screenshot({ path: "screenshots/desk-01-bank.png", fullPage: true });
  await upload();
  const n = await db.su.query("SELECT 1 FROM recon.bank_statements WHERE account = $1", [account]);
  expect(n.rowCount).toBe(1);

  await m.page.goto("/operations/policies");
  await expect(m.page.getByTestId("signer-policies")).toBeVisible();
  await m.page.screenshot({ path: "screenshots/desk-02-policies.png", fullPage: true });
  await m.page.context().close();
});
