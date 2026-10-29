import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import { adminSettings, contiguousMigrations, scratchDatabase } from "./helpers.ts";
import { officer, type TestOfficer } from "./officers.ts";

/**
 * Migration 0046 (TV-1..TV-4): a poll is proposed by an operations maker and approved by a trustee
 * officer; investors vote once on the website with weight = units at the record block; running
 * totals stay hidden; closing records the tally, turnout and quorum.
 */
let su: pg.Client;
let web: pg.Client;
let drop: () => Promise<void>;
let maker: TestOfficer;
let trustee: TestOfficer;
const role = `pt_web_tv_${randomBytes(4).toString("hex")}`;
const password = randomBytes(24).toString("base64url");
const sha = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();
const hex = (n: number): string => `0x${randomBytes(n).toString("hex")}`;
const token = hex(20);

beforeAll(async () => {
  let settings: pg.ClientConfig;
  ({ client: su, settings, drop } = await scratchDatabase());
  await migrate(su, contiguousMigrations());
  await su.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${su.escapeLiteral(password)}`);
  await su.query(`GRANT pt_web TO ${role} WITH INHERIT TRUE, SET FALSE`);
  web = new pg.Client({ ...settings, user: role, password });
  await web.connect();
  maker = await officer(su, "ops.vote.maker", "ops_maker");
  trustee = await officer(su, "trustee.vote.one", "trustee_officer");
  const deployment = `test:${token.slice(2, 12)}`;
  await su.query("INSERT INTO chain.deployments (deployment, chain_id, from_block) VALUES ($1, 586586, 0)", [deployment]);
  await su.query("INSERT INTO chain.tokens (token, deployment, total_supply, updated_block) VALUES ($1, $2, 0, 0)", [token, deployment]);
  await su.query("INSERT INTO chain.cursors (deployment, block_number, block_hash) VALUES ($1, 100, $2)", [deployment, hex(32)]);
}, 180_000);

afterAll(async () => {
  await web.end();
  await drop();
  const root = new pg.Client(adminSettings());
  await root.connect();
  await root.query(`DROP ROLE IF EXISTS ${role}`);
  await root.end();
}, 180_000);

let li = 0;
async function mint(wallet: string, units: bigint, block: number): Promise<void> {
  const deployment = `test:${token.slice(2, 12)}`;
  const bh = hex(32);
  await su.query("INSERT INTO chain.blocks (number, hash, parent_hash, block_time) VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING", [block, bh, hex(32)]);
  const h = (await su.query<{ hash: string }>("SELECT hash FROM chain.blocks WHERE number = $1", [block])).rows[0]?.hash;
  const tx = hex(32);
  await su.query(
    `INSERT INTO chain.events (deployment, block_number, log_index, block_hash, tx_hash, tx_index, address, contract, name, args, topics, data)
     VALUES ($1, $2, $3, $4, $5, 0, $6, 'token', NULL, NULL, '{}', '0x')`,
    [deployment, block, ++li, h, tx, token],
  );
  await su.query("INSERT INTO chain.transfers (deployment, block_number, log_index, token, tx_hash, from_addr, to_addr, amount, kind) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'mint')", [
    deployment, block, li, token, tx, `0x${"0".repeat(40)}`, wallet, units.toString(),
  ]);
}

/** A KYC subject with a bound wallet, a website investor row and a session. */
async function holder(): Promise<{ wallet: string; session: Buffer }> {
  const k = await su.query<{ id: string }>("SELECT kyc.register_subject($1::bytea[], '{1}'::smallint[], $2, $3, '1234', 'kyc-service') AS id", [[randomBytes(32)], randomBytes(32), randomBytes(60)]);
  const wallet = hex(20);
  await su.query("INSERT INTO kyc.wallets (wallet, subject_id, bound_by) VALUES ($1, $2, 'kyc-service')", [wallet, k.rows[0]?.id]);
  const i = await su.query<{ id: string }>("INSERT INTO webdemo.investors (display_name, wallet_address, kyc_status, kyc_subject) VALUES ('Voter', $1, 'verified', $2) RETURNING id", [wallet, k.rows[0]?.id]);
  const t = randomBytes(32).toString("base64url");
  await web.query("SELECT webauth.web_start_session($1, $2, 'signup')", [sha(t), i.rows[0]?.id]);
  return { wallet, session: sha(t) };
}

type R = { ok: boolean; id?: number; status?: string; error?: string };
const call = async (sql: string, params: unknown[]): Promise<R> => (await su.query<{ r: R }>(sql, params)).rows[0]?.r ?? { ok: false };
const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => (e as { code?: string }).code,
  );

describe("token-holder voting (0046)", () => {
  it("propose -> trustee approves -> holders vote once by their units at the record block -> close records tally and quorum", async () => {
    const a = await holder();
    const b = await holder();
    const c = await holder();
    await mint(a.wallet, 600n, 10);
    await mint(b.wallet, 300n, 10);
    await mint(c.wallet, 100n, 60); // after the record block: no vote
    const opens = new Date(Date.now() - 60_000).toISOString();
    const closes = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const p = await call("SELECT admin.propose_poll($1, $2, 'Renew the lease', 'Should the trust renew the anchor tenant lease for five years?', ARRAY['Yes', 'No'], 50, $3, $4, 500000) AS r", [
      maker.sessionHash, token, opens, closes,
    ]);
    expect(p).toMatchObject({ ok: true, status: "proposed" });
    expect(await code(call("SELECT admin.decide_poll($1, $2, 'approve', 'terms match the trust deed') AS r", [maker.sessionHash, p.id]))).toBe("42501");
    expect(await call("SELECT admin.decide_poll($1, $2, 'approve', 'terms match the trust deed') AS r", [trustee.sessionHash, p.id])).toMatchObject({ ok: true, status: "approved" });

    const seen = (await web.query<{ v: { id: number; state: string; weight: string; result: unknown }[] }>("SELECT voting.web_polls($1) AS v", [a.session])).rows[0]?.v;
    expect(seen?.find((x) => x.id === p.id)).toMatchObject({ state: "open", weight: "600", result: null });
    expect(((await web.query<{ v: unknown[] }>("SELECT voting.web_polls($1) AS v", [c.session])).rows[0]?.v ?? []).length).toBe(0);

    expect((await web.query<{ r: R }>("SELECT webauth.web_vote($1, $2, 0) AS r", [a.session, p.id])).rows[0]?.r).toMatchObject({ ok: true });
    expect(await code(web.query("SELECT webauth.web_vote($1, $2, 1)", [a.session, p.id]))).toBe("23514");
    expect(await code(web.query("SELECT webauth.web_vote($1, $2, 0)", [c.session, p.id]))).toBe("23514");
    expect(await code(web.query("SELECT webauth.web_vote($1, $2, 7)", [b.session, p.id]))).toBe("23514");
    await web.query("SELECT webauth.web_vote($1, $2, 1)", [b.session, p.id]);
    expect(await code(su.query("UPDATE voting.ballots SET choice = 1"))).toBe("42501");
    expect((await call("SELECT admin.close_poll($1, $2) AS r", [maker.sessionHash, p.id])).ok).toBe(false);

    // The closing time passes (TEST ONLY: a poll's terms never change otherwise).
    await su.query("ALTER TABLE voting.polls DISABLE TRIGGER polls_guard");
    await su.query("UPDATE voting.polls SET opens_at = now() - interval '3 days', closes_at = now() - interval '1 hour' WHERE id = $1", [p.id]);
    await su.query("ALTER TABLE voting.polls ENABLE TRIGGER polls_guard");
    expect(await call("SELECT admin.close_poll($1, $2) AS r", [maker.sessionHash, p.id])).toMatchObject({ ok: true, status: "closed" });
    const result = (await su.query<{ r: { options: { weight: string }[]; votedWeight: string; unitsAtRecord: string; turnoutPpm: number; quorumMet: boolean } }>(
      "SELECT result AS r FROM voting.polls WHERE id = $1", [p.id])).rows[0]?.r;
    expect(result?.options.map((o) => o.weight)).toEqual(["600", "300"]);
    expect(result).toMatchObject({ votedWeight: "900", unitsAtRecord: "900", turnoutPpm: 1000000, quorumMet: true });
  });

  it("the website reaches nothing else of the voting schema", async () => {
    expect(await code(web.query("SELECT * FROM voting.ballots"))).toBe("42501");
    expect(await code(web.query("SELECT voting.tally(1)"))).toBe("42501");
    expect(await code(web.query("SELECT admin.polls($1)", [randomBytes(32)]))).toBe("42501");
  });
});
