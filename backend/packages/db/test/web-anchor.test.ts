import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import { adminSettings, contiguousMigrations, scratchDatabase } from "./helpers.ts";

/**
 * Migration 0025 WN-1..WN-4: the website's role (pt_web) may execute exactly anchor.web_status()
 * and anchor.web_recent(integer) in schema anchor and nothing else there; the functions return public
 * values only (never the raw transaction, nonce, sender, creator or failure reason), scoped to the
 * newest anchor target, at most 20 rows, and never a failed anchor.
 */
const role = `pt_web_anchor_${randomBytes(4).toString("hex")}`;
const password = randomBytes(24).toString("base64url");
let admin: pg.Client;
let drop: () => Promise<void>;
let web: pg.Client;

const ALLOWED = ["anchor.web_recent(p_limit integer)", "anchor.web_status()"];
const CHAIN = 586_650;
const OLD_CONTRACT = `0x${"0a".repeat(20)}`;
const CONTRACT = `0x${"0b".repeat(20)}`;
const hex32 = () => `0x${randomBytes(32).toString("hex")}`;
const hex20 = () => `0x${randomBytes(20).toString("hex")}`;

let block = 100;
let journal = 1;

/** Records an anchor through the writer API (as the administrator) and returns its id. */
async function record(contract = CONTRACT): Promise<string> {
  block += 10;
  journal += 1;
  const { rows } = await admin.query<{ id: string }>("SELECT anchor.record($1, $2, 586586, $3, $4, $5, $6, $7, 'test') AS id", [
    CHAIN, contract, block, hex32(), journal, hex32(), hex32(),
  ]);
  return rows[0]?.id ?? "";
}

async function confirm(id: string): Promise<string> {
  const tx = hex32();
  await admin.query("SELECT anchor.mark_sent($1, $2, 7, $3, $4, 'test')", [id, tx, hex20(), `0x${randomBytes(120).toString("hex")}`]);
  await admin.query("SELECT anchor.confirm($1, $2, 999, $3, 'test')", [id, tx, hex32()]);
  return tx;
}

beforeAll(async () => {
  let settings: pg.ClientConfig;
  ({ client: admin, settings, drop } = await scratchDatabase());
  await migrate(admin, contiguousMigrations());
  await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${admin.escapeLiteral(password)}`);
  await admin.query(`GRANT pt_web TO ${role} WITH INHERIT TRUE, SET FALSE`);
  web = new pg.Client({ ...settings, user: role, password });
  await web.connect();
}, 120_000);

afterAll(async () => {
  await web.end();
  await drop();
  const root = new pg.Client(adminSettings());
  await root.connect();
  await root.query(`DROP ROLE IF EXISTS ${role}`);
  await root.end();
});

async function denied(sql: string, params: unknown[] = []): Promise<void> {
  await expect(web.query(sql, params)).rejects.toMatchObject({ code: "42501" });
}

describe("the website's anchor status functions (migration 0025)", () => {
  it("pt_web can execute exactly anchor.web_status and anchor.web_recent in schema anchor (directly or via PUBLIC)", async () => {
    const { rows } = await admin.query<{ f: string }>(
      `SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS f
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'anchor' AND has_function_privilege('pt_web', p.oid, 'EXECUTE')
       ORDER BY 1`,
    );
    expect(rows.map((r) => r.f)).toEqual(ALLOWED);
    const { rows: viaMember } = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'anchor' AND has_function_privilege($1, p.oid, 'EXECUTE')`,
      [role],
    );
    expect(viaMember[0]?.n).toBe(String(ALLOWED.length));
  });

  it("returns nothing before the first anchor", async () => {
    expect((await web.query("SELECT * FROM anchor.web_status()")).rows).toEqual([]);
    expect((await web.query("SELECT * FROM anchor.web_recent(12)")).rows).toEqual([]);
  });

  it("cannot read any table, sequence or view of schema anchor", async () => {
    const { rows } = await admin.query<{ t: string }>(
      `SELECT format('%I.%I', n.nspname, c.relname) AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'anchor' AND c.relkind IN ('r', 'v', 'm', 'p') ORDER BY 1`,
    );
    expect(rows.map((r) => r.t)).toEqual(["anchor.anchors", "anchor.history"]);
    for (const { t } of rows) await denied(`SELECT 1 FROM ${t} LIMIT 1`);
  });

  it.each([
    ["record an anchor", `SELECT anchor.record(${String(CHAIN)}, '${CONTRACT}', 586586, 1, '${hex32()}', 1, '${hex32()}', '${hex32()}', 'web')`],
    ["mark an anchor sent", `SELECT anchor.mark_sent(1, '${hex32()}', 1, '${hex20()}', '0x00', 'web')`],
    ["confirm an anchor", `SELECT anchor.confirm(1, '${hex32()}', 1, '${hex32()}', 'web')`],
    ["clear a dropped anchor", `SELECT anchor.clear_dropped(1, '${hex32()}', 'web cannot', 'web')`],
    ["fail an anchor", "SELECT anchor.fail(1, 'web cannot fail anchors', 'web')"],
    ["write the anchor history", "SELECT anchor.log(1, 'web', 'fail', '{}'::jsonb)"],
    ["insert an anchor row", `INSERT INTO anchor.anchors (anchor_chain_id) VALUES (1)`],
    ["update an anchor row", "UPDATE anchor.anchors SET status = 'failed'"],
  ])("cannot %s", async (_label, sql) => {
    await denied(sql);
  });

  it("shows the latest confirmed anchor of the newest target with public values only", async () => {
    // An earlier deployment (another contract) never mixes with the current one (WN-3).
    await confirm(await record(OLD_CONTRACT));
    const first = await record();
    await confirm(first);
    const second = await record();
    const tx = await confirm(second);
    const status = await web.query("SELECT * FROM anchor.web_status()");
    expect(status.fields.map((f) => f.name)).toEqual([
      "anchor_chain_id", "contract", "besu_chain_id", "besu_block", "commitment", "tx_hash", "anchor_block", "confirmed_at",
      "confirmed_count", "age_seconds", "open_state", "open_since",
    ]);
    expect(status.rows).toHaveLength(1);
    const want = (await admin.query("SELECT besu_block, commitment FROM anchor.anchors WHERE id = $1", [second])).rows[0] as { besu_block: string; commitment: string };
    expect(status.rows[0]).toMatchObject({
      anchor_chain_id: String(CHAIN), contract: CONTRACT, besu_chain_id: "586586", besu_block: want.besu_block, commitment: want.commitment,
      tx_hash: tx, anchor_block: "999", confirmed_count: "2", open_state: "none", open_since: null,
    });
    expect(Number((status.rows[0] as { age_seconds: string }).age_seconds)).toBeGreaterThanOrEqual(0);

    const recent = await web.query("SELECT * FROM anchor.web_recent(12)");
    expect(recent.fields.map((f) => f.name)).toEqual([
      "id", "anchor_chain_id", "contract", "besu_chain_id", "besu_block", "besu_block_hash", "ledger_journal_id", "ledger_head_hash",
      "commitment", "status", "tx_hash", "anchor_block", "confirmed_at",
    ]);
    expect(recent.rows.map((r: { id: string }) => r.id)).toEqual([second, first]);
    // WN-2: never the raw transaction, nonce, sender, creator or failure reason.
    const raws = (await admin.query<{ raw_tx: string; tx_from: string }>("SELECT raw_tx, tx_from FROM anchor.anchors WHERE raw_tx IS NOT NULL")).rows;
    const json = JSON.stringify([status.rows, recent.rows]);
    for (const r of raws) {
      expect(json).not.toContain(r.raw_tx.slice(2, 60));
      expect(json).not.toContain(r.tx_from.slice(2));
    }
    expect(json).not.toMatch(/"(raw_tx|tx_nonce|tx_from|created_by|failure)"/);
  });

  it("reports a pending anchor, then a failed one as a coarse state without its reason", async () => {
    const open = await record();
    let s = (await web.query<{ open_state: string; open_since: Date | null }>("SELECT open_state, open_since FROM anchor.web_status()")).rows[0];
    expect(s?.open_state).toBe("pending");
    expect(s?.open_since).toBeInstanceOf(Date);
    // A recorded anchor is listed (its components are public), without a transaction yet.
    expect((await web.query("SELECT status, tx_hash FROM anchor.web_recent(1)")).rows).toEqual([{ status: "recorded", tx_hash: null }]);

    await admin.query("SELECT anchor.fail($1, 'internal: rpc http://10.0.0.5 refused', 'test')", [open]);
    s = (await web.query<{ open_state: string; open_since: Date | null }>("SELECT open_state, open_since FROM anchor.web_status()")).rows[0];
    expect(s?.open_state).toBe("failed");
    expect(s?.open_since).toBeInstanceOf(Date);
    const all = JSON.stringify((await web.query("SELECT * FROM anchor.web_status()")).rows) + JSON.stringify((await web.query("SELECT * FROM anchor.web_recent(20)")).rows);
    expect(all).not.toContain("10.0.0.5");
    // WN-4: a failed anchor is never listed.
    expect((await web.query<{ id: string }>("SELECT id FROM anchor.web_recent(20)")).rows.map((r) => r.id)).not.toContain(open);

    // The next confirmed anchor clears the failed state.
    await confirm(await record());
    expect((await web.query("SELECT open_state, confirmed_count FROM anchor.web_status()")).rows).toEqual([{ open_state: "none", confirmed_count: "3" }]);
  });

  it("caps the list at 20 rows and treats a missing or non-positive limit as 12", async () => {
    for (let i = 0; i < 22; i++) await confirm(await record());
    const count = async (limit: number | null) => (await web.query("SELECT 1 FROM anchor.web_recent($1)", [limit])).rowCount;
    expect(await count(1000)).toBe(20);
    expect(await count(null)).toBe(12);
    expect(await count(0)).toBe(12);
    expect(await count(-5)).toBe(12);
    expect(await count(3)).toBe(3);
  });
});
