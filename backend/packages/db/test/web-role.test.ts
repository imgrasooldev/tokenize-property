import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import { adminSettings, scratchDatabase } from "./helpers.ts";

/**
 * Migration 0012 W-5: the website's database role (pt_web) can do exactly what the website needs
 * and nothing that belongs to the ledger, the signer, operations, KYC, the bank or the indexer.
 */
const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));
const role = `pt_web_test_${randomBytes(4).toString("hex")}`;
const password = randomBytes(24).toString("base64url");
let admin: pg.Client;
let drop: () => Promise<void>;
let web: pg.Client;

beforeAll(async () => {
  let settings: pg.ClientConfig;
  ({ client: admin, settings, drop } = await scratchDatabase());
  await migrate(admin, MIGRATIONS);
  await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${admin.escapeLiteral(password)}`);
  await admin.query(`GRANT pt_web TO ${role} WITH INHERIT TRUE, SET FALSE`);
  await admin.query("SELECT ledger.open_account('web:bank:subscriptions', 'asset', 'PKR', false)");
  web = new pg.Client({ ...settings, user: role, password });
  await web.connect();
});

afterAll(async () => {
  await web.end();
  await drop();
  const root = new pg.Client(adminSettings());
  await root.connect();
  await root.query(`DROP ROLE IF EXISTS ${role}`);
  await root.end();
});

/** The statement must fail with insufficient_privilege (42501), not merely with some error. */
async function denied(sql: string, params: unknown[] = []): Promise<void> {
  await expect(web.query(sql, params)).rejects.toMatchObject({ code: "42501" });
}

describe("the website's database role (pt_web)", () => {
  it("does what the website needs: its own records, journals through the ledger API, outbox commands, the read model", async () => {
    const id = randomUUID();
    await web.query("INSERT INTO webdemo.investors (id, display_name, wallet_address, kyc_status) VALUES ($1, 'Role Test', $2, 'pending')", [id, `0x${"ab".repeat(20)}`]);
    await web.query("UPDATE webdemo.investors SET kyc_status = 'verified' WHERE id = $1", [id]);
    await web.query("SELECT ledger.open_account($1, 'liability', 'PKR', false)", [`web:investor:${id}:subscription`]);
    await web.query(
      "SELECT ledger.post_journal($1, 'subscription_paid', NULL, 'RAAST-DEMO-0123456789AB', 'web', $2::jsonb)",
      [`web:sub:${id}:paid`, JSON.stringify([{ account: "web:bank:subscriptions", amount: "100" }, { account: `web:investor:${id}:subscription`, amount: "-100" }])],
    );
    expect((await web.query("SELECT balance FROM ledger.balances WHERE code = 'web:bank:subscriptions'")).rows).toEqual([{ balance: "100" }]);
    await web.query("SELECT outbox.enqueue($1, 'issuance.mint', '{}'::jsonb, NULL, 'web')", [`web:sub:${id}:mint`]);
    await web.query("SELECT status FROM outbox.commands");
    await web.query("SELECT * FROM chain.cursors");
    await web.query("SELECT * FROM signer.custodial_wallets");
    await web.query("SELECT count(*) FROM ledger.verify_chain()");
  });

  it.each([
    ["change a journal", "UPDATE ledger.journal SET memo = 'x'"],
    ["delete postings", "DELETE FROM ledger.postings"],
    ["write a posting directly", "INSERT INTO ledger.postings (journal_id, account_id, asset, amount) VALUES (1, 1, 'PKR', 1)"],
    ["change running balances", "UPDATE ledger.account_balances SET balance = 0"],
    ["delete its own records", "DELETE FROM webdemo.investors"],
    ["truncate its own records", "TRUNCATE webdemo.trades"],
    ["create tables", "CREATE TABLE webdemo.x (id int)"],
    ["alter its tables", "ALTER TABLE webdemo.orders ADD COLUMN x int"],
    ["write the outbox directly", "UPDATE outbox.commands SET status = 'confirmed'"],
    ["resolve outbox reviews", "SELECT outbox.operator_decide(1, 'web', 'confirm', 'web cannot do this')"],
    ["claim outbox work", "SELECT * FROM outbox.claim('web', 1, 30)"],
    ["approve signing requests", `SELECT signer.decide('${randomUUID()}', 'web', 'approve', 'x')`],
    ["propose policies", "SELECT signer.propose_policy('issuance.mint', '{}'::jsonb, 'web')"],
    ["read signing requests", "SELECT * FROM signer.requests"],
    ["create custodial wallets", "SELECT signer.register_custodial_wallet('0x00000000000000000000000000000000000000aa', 'generated', 'web')"],
    ["unfreeze payouts", "SELECT recon.request_unfreeze('web', 'web cannot unfreeze payouts')"],
    ["clear an indexer halt", "SELECT chain.clear_halt('x', 'web', 'x')"],
    ["write the read model", "UPDATE chain.holdings SET balance = 0"],
    ["read KYC records", "SELECT * FROM kyc.subjects"],
    ["revoke a KYC verification", `SELECT kyc.revoke('${randomUUID()}', 'web', 'web cannot revoke')`],
    ["read bank records", "SELECT * FROM bank.payees"],
  ])("cannot %s", async (_label, sql) => {
    await denied(sql);
  });

  it("is not a superuser and cannot create roles or databases", async () => {
    const { rows } = await admin.query<{ rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean }>(
      "SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = 'pt_web'");
    expect(rows).toEqual([{ rolsuper: false, rolcreaterole: false, rolcreatedb: false }]);
    await denied("CREATE ROLE web_should_not_exist");
  });
});
