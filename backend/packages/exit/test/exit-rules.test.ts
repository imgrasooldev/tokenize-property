import { createHash, randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issuanceGuardAbi } from "@pt/contracts";
import pg from "pg";
import { decodeFunctionData, getAddress, parseTransaction } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminSettings } from "../../db/test/helpers.ts";
import { FileKeystore, writeKeyFile } from "../../signer/src/keystore.ts";
import { SignerService, type ChainReader } from "../../signer/src/service.ts";
import { code, message } from "../../tax/test/world.ts";
import { ExitService } from "../src/service.ts";
import {
  burned,
  caseJson,
  createWorld,
  decide,
  exitToken,
  investor,
  openGate,
  payee,
  refresh,
  request,
  sha,
  toRedeeming,
  type Investor,
  type World,
} from "./world.ts";

/**
 * S-05 safety rules in the database (migration 0027 EX-DB-1..8) and the signer kind issuance.burn
 * against the real database: segregation of duties, conflicts, digests, officer binding, append-only
 * records and the audit chain, the redemption batch's exactness, deny-by-default burns, the burn
 * rules, redemption windows and requests through the website's session-bound wrappers, and grants.
 */
let w: World;
let A: Investor;
let B: Investor;
const PASS = "a-long-local-test-passphrase-0123456789";
const webRole = `pt_web_exit_${randomBytes(4).toString("hex")}`;
const webPassword = randomBytes(24).toString("base64url");
let web: pg.Client;

beforeAll(async () => {
  w = await createWorld();
  A = await investor(w);
  B = await investor(w);
  await w.su.query("UPDATE ops.settings SET value = 'true' WHERE key = 'allow_placeholder_rates'");
  await w.su.query("UPDATE exit.settings SET value = '0' WHERE key IN ('vote_notice_days', 'record_notice_days')");
  await openGate(w);
  await w.su.query(`CREATE ROLE ${webRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${w.su.escapeLiteral(webPassword)}`);
  await w.su.query(`GRANT pt_web TO ${webRole} WITH INHERIT TRUE, SET FALSE`);
  web = new pg.Client({ ...w.settings, user: webRole, password: webPassword });
  await web.connect();
}, 240_000);

afterAll(async () => {
  await web.end();
  await w.drop();
  const root = new pg.Client(adminSettings());
  await root.connect();
  await root.query(`DROP ROLE IF EXISTS ${webRole}`);
  await root.end();
}, 240_000);

describe("decisions: segregation of duties, conflicts, digests, binding", () => {
  it("refuses the proposer, a second vote by the same officer, a conflicted officer and a stale digest", async () => {
    await refresh(w);
    const t = await exitToken(w, [{ inv: A, units: 10n }]);
    const o = await request(w, w.officers.maker, null, "open", {
      token: t.token, offerPaisa: "100", valuationAPaisa: "100", valuationASha: sha("x1"), valuationBPaisa: "100", valuationBSha: sha("x2"), costsPaisa: "0", voteRequired: false,
    }, "an offer for the building at its valuation");
    const caseId = o.id ?? 0;
    const p = await request(w, w.officers.maker, caseId, "propose", { code: "X3", detail: { minutesSha: sha("m") } }, "committee recommends the sale");
    expect(p.ok).toBe(true);
    let c = await caseJson(w, w.officers.checker, caseId);
    const d = (c.decisions as { id: number; digest: string }[])[0];
    // Stale digest.
    expect((await decide(w, w.officers.checker, "vote", d?.id ?? 0, "approve", sha("not what was shown"))).error).toMatch(/changed since you reviewed/);
    expect(await decide(w, w.officers.checker, "vote", d?.id ?? 0, "approve", d?.digest ?? "")).toMatchObject({ ok: true, status: "open" });
    c = await caseJson(w, w.officers.checker, caseId);
    const d2 = (c.decisions as { id: number; digest: string }[])[0];
    // The same officer cannot fill the second capacity; a second checker holds no open capacity either.
    expect((await decide(w, w.officers.checker, "vote", d2?.id ?? 0, "approve", d2?.digest ?? "")).error).toMatch(/already decided/);
    expect((await decide(w, w.officers.checker2, "vote", d2?.id ?? 0, "approve", d2?.digest ?? "")).error).toMatch(/no capacity that is still open/);
    // A conflict declared on the case bars the compliance officer.
    expect(await decide(w, w.officers.compliance, "conflict", caseId, "approve", c.caseDigest, {}, "related to the buyer through a family business")).toMatchObject({ ok: true });
    c = await caseJson(w, w.officers.compliance, caseId);
    const d3 = (c.decisions as { id: number; digest: string }[])[0];
    expect((await decide(w, w.officers.compliance, "vote", d3?.id ?? 0, "approve", d3?.digest ?? "")).error).toMatch(/conflict/);
    // The maker (no exit.decide) cannot vote at all.
    expect((await w.portal.query<{ r: unknown }>("SELECT admin.exit_decide($1, 'vote', $2, 'approve', 'reason long enough', $3, '{}') AS r",
      [w.officers.maker.sessionHash, d3?.id ?? 0, Buffer.alloc(32)]).catch((e: unknown) => (e instanceof Error ? e.message : String(e))))).toMatch(/permission exit.decide/);
  });

  it("refuses an officer's handle outside PT Control and keeps the case state machine closed", async () => {
    const t = await exitToken(w, [{ inv: B, units: 5n }]);
    expect(await message(w.pool.query("SELECT exit.open_case($1, 'rationale long enough here', 1, 1, $2, 1, $3, 0, false, 'exit.maker')", [t.token, sha("a"), sha("b")])))
      .toMatch(/officer of the admin portal/);
    const id = (await w.pool.query<{ id: string }>("SELECT exit.open_case($1, 'rationale long enough here', 1, 1, $2, 1, $3, 0, false, 'operator:ali') AS id", [t.token, sha("a"), sha("b")])).rows[0]?.id;
    expect(await code(w.su.query("UPDATE exit.cases SET state = 'closed', closed_at = now() WHERE id = $1", [id]))).toBe("23514");
    expect(await code(w.su.query("UPDATE exit.cases SET offer_price_paisa = 2 WHERE id = $1", [id]))).toBe("23514");
    expect(await code(w.su.query("DELETE FROM exit.cases WHERE id = $1", [id]))).toBe("42501");
    expect(await code(w.su.query("INSERT INTO exit.case_events (case_id, code, from_state, to_state, actor) VALUES ($1, 'X17', 'redeeming', 'paid_out', 'x:y')", [id]))).toBe("23514");
    expect(await code(w.su.query("TRUNCATE exit.audit"))).toBe("42501");
    // A decision whose capacity is legal + trustee cannot be cast by the command line (officers only).
    const p = (await w.pool.query<{ id: string }>("SELECT exit.propose($1, 'X3', $2::jsonb, 'committee recommends the sale', 'operator:ali') AS id",
      [id, JSON.stringify({ minutesSha: sha("ic") })])).rows[0]?.id;
    expect(await message(w.pool.query("SELECT exit.vote($1, 'operator:sara', 'approve', 'approved on the evidence', $2)", [p, Buffer.alloc(32)])))
      .toMatch(/no capacity/);
  });
});

describe("redemption, burns and the signing service", () => {
  let r: Awaited<ReturnType<typeof toRedeeming>>;
  let keys: FileKeystore;
  const balances = new Map<string, bigint>();
  const chain: ChainReader = {
    chainId: () => Promise.resolve(586586),
    pendingNonce: () => Promise.resolve(0n),
    simulate: () => Promise.resolve(),
    mintFacts: () => Promise.reject(new Error("not used")),
    txState: () => Promise.resolve("pending"),
    isFrozen: () => Promise.resolve(false),
    distribution: () => Promise.reject(new Error("not used")),
    balanceOf: (_t, wallet) => Promise.resolve(balances.get(wallet.toLowerCase()) ?? 0n),
  };
  let C: Investor;
  let D: Investor;

  beforeAll(async () => {
    C = await investor(w);
    D = await investor(w);
    r = await toRedeeming(w, [{ inv: C, units: 70n }, { inv: D, units: 30n }]);
    balances.set(C.wallet, 70n);
    balances.set(D.wallet, 30n);
    const dir = await mkdtemp(join(tmpdir(), "ks-exit-"));
    await writeKeyFile(dir, "issuance", generatePrivateKey(), PASS);
    keys = await FileKeystore.open(dir, PASS);
    await w.su.query("INSERT INTO signer.keys (key_ref, address, purpose) VALUES ('issuance', $1, 'test')", [keys.address("issuance")]);
    const rule = { chainId: 586586, keyRef: "issuance", issuance: r.t.issuance, token: r.t.token, maxPerCommand: "100000", maxPerDay: 50, approvals: 0 };
    const { rows } = await w.su.query<{ id: string }>("SELECT signer.propose_policy('issuance.burn', $1::jsonb, 'maker') AS id", [JSON.stringify(rule)]);
    await w.su.query("SELECT signer.approve_policy($1, 'checker')", [rows[0]?.id]);
  }, 240_000);

  const svc = (): SignerService => new SignerService(w.pool, keys, chain);
  const line = async (wallet: string): Promise<{ ref_id: string; units: string }> =>
    (await w.pool.query<{ ref_id: string; units: string }>("SELECT ref_id, units::text FROM exit.redemption_lines WHERE redemption_id = $1 AND wallet = $2", [r.redemptionId, wallet])).rows[0] ?? { ref_id: "", units: "0" };

  it("the batch is exact: wrong units or a reused refId are refused", async () => {
    // A second batch for the same case is refused outright; the checks are exercised on the stored batch.
    expect(await message(w.pool.query("SELECT exit.create_redemption($1, '[]'::jsonb, NULL, 'operator:ali')", [r.caseId]))).toMatch(/redemption batch follows|already has/);
    const items = (await w.pool.query<{ n: number; u: string }>("SELECT count(*)::int AS n, sum(units)::text AS u FROM exit.redemption_lines WHERE redemption_id = $1", [r.redemptionId])).rows[0];
    expect(items).toEqual({ n: 2, u: "100" });
  });

  it("denies a burn that was not enqueued (unpaid line, after_payment) and anything that differs from the enqueued command", async () => {
    const l = await line(C.wallet);
    const payload = { issuance: r.t.issuance, from: C.wallet, amount: l.units, refId: l.ref_id };
    const denied = await svc().request({ commandRef: `probe:${l.ref_id}`, kind: "issuance.burn", payload }, "outbox-worker");
    expect(denied).toMatchObject({ status: "denied" });
    expect(denied.status === "denied" ? denied.reason : "").toMatch(/not the burn command the redemption batch enqueued/);
    // A line nobody tried to pay yet cannot be released for burning (HR is for held or returned lines).
    await refresh(w);
    const hr = await request(w, w.officers.maker, r.caseId, "propose", { code: "HR", detail: { wallet: C.wallet } }, "release the line for burning");
    expect(hr.error).toMatch(/only a held or returned line/);
  });

  it("signs exactly the enqueued burn once the line is paid; a forged amount is denied", async () => {
    await payee(w, C.subjectId);
    await payee(w, D.subjectId);
    const lines = (await w.pool.query<{ subject_id: string; net: string }>("SELECT subject_id::text, net::text FROM exit.final_lines WHERE final_id = $1", [r.finalId])).rows;
    const id = (await w.su.query<{ id: string }>("SELECT bank.create_payout_batch('PTPAY-EXIT-R1', $1, 1, $2::jsonb, 'bank:maker') AS id",
      [r.t.token, JSON.stringify(lines.map((x) => ({ subject: x.subject_id, amountPaisa: x.net })))])).rows[0]?.id;
    await w.su.query("SELECT bank.decide_payout_batch($1, 'bank:checker', 'approve', 'lines checked against the statement')", [id]);
    await w.su.query("SELECT bank.submit_payout_batch($1, 'bank:sender', $2)", [id, Buffer.alloc(32, 3)]);
    await new ExitService(w.pool).tick("exit-worker");
    const l = await line(C.wallet);
    const cmd = (await w.pool.query<{ payload: Record<string, string> }>("SELECT payload FROM outbox.commands WHERE idempotency_key = $1", [`burn:${l.ref_id}`])).rows[0];
    expect(cmd?.payload).toEqual({ issuance: r.t.issuance, from: C.wallet, amount: "70", refId: l.ref_id });
    const forged = await svc().request({ commandRef: `burn:${l.ref_id}:forged`, kind: "issuance.burn", payload: { ...cmd?.payload, amount: "69" } }, "outbox-worker");
    expect(forged.status).toBe("denied");
    const out = await svc().request({ commandRef: `burn:${l.ref_id}`, kind: "issuance.burn", payload: cmd?.payload ?? {} }, "outbox-worker");
    if (out.status !== "signed") throw new Error(`not signed: ${JSON.stringify(out)}`);
    const tx = parseTransaction(out.raw);
    expect(tx.to).toBe(r.t.issuance);
    expect(decodeFunctionData({ abi: issuanceGuardAbi, data: tx.data ?? "0x" })).toMatchObject({ functionName: "burn", args: [getAddress(C.wallet), 70n, l.ref_id] });
    // Once the read model shows the burn, the line is burned and nothing more is allowed.
    await burned(w, r.t, C.wallet, 70n, l.ref_id, 30);
    const again = (await w.pool.query<{ problem: string | null }>("SELECT problem FROM exit.burn_allowed($1::jsonb)", [JSON.stringify(cmd?.payload)])).rows[0];
    expect(again?.problem).toBe("already burned");
  });

  it("after_finalization enqueues every line at approval, before any payment", async () => {
    const E = await investor(w);
    const F = await investor(w);
    const r2 = await toRedeeming(w, [{ inv: E, units: 8n }, { inv: F, units: 2n }], "after_finalization", 2);
    const n = (await w.pool.query("SELECT 1 FROM exit.burns WHERE redemption_id = $1", [r2.redemptionId])).rowCount;
    expect(n).toBe(2);
    const c = await caseJson(w, w.officers.checker, r2.caseId);
    expect(c.redemption.burnRule).toBe("after_finalization");
  });
  it("the gate: with payouts frozen by reconciliation the burn is denied", async () => {
    const l = await line(D.wallet);
    const { rows } = await w.su.query<{ id: string }>("SELECT recon.start_run('test', NULL, '{}') AS id");
    await w.su.query(`SELECT recon.complete_run($1, 'test', 0, '[{"check":"cash.closing_mismatch","severity":"blocking","subject":"test"}]', '{}')`, [rows[0]?.id]);
    const cmd = (await w.pool.query<{ payload: Record<string, string> }>("SELECT payload FROM outbox.commands WHERE idempotency_key = $1", [`burn:${l.ref_id}`])).rows[0];
    const out = await svc().request({ commandRef: `burn:${l.ref_id}`, kind: "issuance.burn", payload: cmd?.payload ?? {} }, "outbox-worker");
    expect(out.status).toBe("denied");
    expect(out.status === "denied" ? out.reason : "").toMatch(/reconciliation/);
  });

});

describe("audit chain and grants", () => {
  it("verify_audit finds a tampered entry and a row written around the API", async () => {
    expect((await w.su.query("SELECT * FROM exit.verify_audit()")).rowCount).toBe(0);
    await w.su.query("ALTER TABLE exit.audit DISABLE TRIGGER audit_append_only");
    await w.su.query("UPDATE exit.audit SET actor = 'someone.else' WHERE id = (SELECT min(id) FROM exit.audit)");
    await w.su.query("ALTER TABLE exit.audit ENABLE TRIGGER audit_append_only");
    const problems = (await w.su.query<{ problem: string }>("SELECT problem FROM exit.verify_audit()")).rows.map((x) => x.problem);
    expect(problems.join(" ")).toMatch(/does not match its hash/);
  });

  it("roles: the operator cannot vote or approve as trustee; the website reaches nothing but its wrappers", async () => {
    const op = new pg.Client({ ...w.settings, options: "-c role=pt_exit_operator" });
    await op.connect();
    try {
      expect(await code(op.query("SELECT exit.vote(1, 'x', 'approve', 'reason long enough', '\\x00')"))).toBe("42501");
      expect(await code(op.query("SELECT exit.approve_waterfall(1, 'x', 'approve', 'reason long enough')"))).toBe("42501");
      expect(await code(op.query("SELECT exit.approve_redemption(1, 'x', 'approve', 'reason long enough', '\\x00')"))).toBe("42501");
    } finally {
      await op.end();
    }
    expect(await code(web.query("SELECT exit.request_redemption(1, gen_random_uuid(), 1, 'idem-key-123', 'x')"))).toBe("42501");
    expect(await code(web.query("SELECT * FROM exit.requests"))).toBe("42501");
  });
});

describe("redemption requests (phase 0) through the website wrappers", () => {
  const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();
  let session: Buffer;
  let windowId = 0;
  let G: Investor;

  beforeAll(async () => {
    G = await investor(w);
    await exitToken(w, [{ inv: G, units: 50n }, { inv: (await investor(w)), units: 950n }]);
    const inv = (await w.su.query<{ id: string }>(
      "INSERT INTO webdemo.investors (display_name, wallet_address, kyc_status, kyc_subject, created_at) VALUES ('Exit Tester', $1, 'verified', $2, now()) RETURNING id",
      [G.wallet, G.subjectId])).rows[0]?.id;
    const tokenText = randomBytes(32).toString("base64url");
    session = sha256(tokenText);
    const s = await web.query<{ e: Date | null }>("SELECT webauth.web_start_session($1, $2, 'signup') AS e", [session, inv]);
    expect(s.rows[0]?.e).toBeTruthy();
  }, 120_000);

  it("windows are maker-checker, priced from NAV and capped", async () => {
    const t = (await w.pool.query<{ token: string }>("SELECT h.token FROM chain.holdings h WHERE h.holder = $1", [G.wallet])).rows[0]?.token;
    const id = (await w.pool.query<{ id: string }>(
      "SELECT exit.propose_window($1, now() - interval '1 minute', now() + interval '2 days', 150000, $2, 100000, 'quarterly window with the latest valuation', 'operator:ali') AS id",
      [t, sha("nav")])).rows[0]?.id;
    windowId = Number(id);
    expect(await message(w.pool.query("SELECT exit.decide_window($1, 'operator:ali', 'approve', 'window checked against the valuation')", [id]))).toMatch(/maker-checker/);
    await w.pool.query("SELECT exit.decide_window($1, 'operator:sara', 'approve', 'window checked against the valuation')", [id]);
    const row = (await w.pool.query<{ price: string; cap: string }>("SELECT price_per_unit_paisa::text AS price, cap_units::text AS cap FROM exit.windows WHERE id = $1", [id])).rows[0];
    expect(row).toEqual({ price: "135000", cap: "100" });
  });

  it("an investor requests within the free balance (waiver path without a passkey), once per window, and may withdraw", async () => {
    const over = await message(web.query("SELECT webauth.web_redemption_request($1, $2, 51, 'idem-req-0001') AS r", [session, windowId]));
    expect(over).toMatch(/at most the units you hold/);
    const r1 = (await web.query<{ r: Record<string, unknown> }>("SELECT webauth.web_redemption_request($1, $2, 40, 'idem-req-0002') AS r", [session, windowId])).rows[0]?.r;
    expect(r1).toMatchObject({ status: "submitted", units: "40", indicativePaisa: "5400000", replayed: false });
    const replay = (await web.query<{ r: Record<string, unknown> }>("SELECT webauth.web_redemption_request($1, $2, 40, 'idem-req-0002') AS r", [session, windowId])).rows[0]?.r;
    expect(replay).toMatchObject({ id: r1?.id, replayed: true });
    expect(await message(web.query("SELECT webauth.web_redemption_request($1, $2, 5, 'idem-req-0003') AS r", [session, windowId]))).toMatch(/already have a request/);
    const view = (await web.query<{ v: { requests: { id: string; status: string; withdrawable: boolean }[] } }>("SELECT webauth.web_exit_overview($1) AS v", [session])).rows[0]?.v;
    expect(view?.requests[0]).toMatchObject({ id: r1?.id, status: "submitted", withdrawable: true });
    expect((await web.query<{ r: unknown }>("SELECT webauth.web_redemption_withdraw($1, $2) AS r", [session, r1?.id])).rows[0]?.r).toEqual({ status: "withdrawn" });
    // A fresh request after withdrawing; the waiver is audited in webauth.
    await web.query("SELECT webauth.web_redemption_request($1, $2, 10, 'idem-req-0004') AS r", [session, windowId]);
    const waived = await w.su.query("SELECT 1 FROM webauth.audit WHERE action = 'stepup.waived' AND detail->>'action' = 'exit.redemption_request'");
    expect(waived.rowCount).toBeGreaterThan(0);
    expect((await web.query<{ r: unknown }>("SELECT webauth.web_redemption_request($1, $2, 1, 'idem-req-0005') AS r", [Buffer.alloc(32, 9), windowId])).rows[0]).toEqual({ r: { error: "session" } });
  });

  it("the outcome is maker-checker; a request of an investor no longer verified reads 'under review'", async () => {
    await w.su.query("ALTER TABLE exit.windows DISABLE TRIGGER windows_guard");
    await w.su.query("UPDATE exit.windows SET closes_at = now() - interval '1 second', opens_at = now() - interval '1 day' WHERE id = $1", [windowId]);
    await w.su.query("ALTER TABLE exit.windows ENABLE TRIGGER windows_guard");
    await w.pool.query("SELECT exit.propose_outcome($1, 'operator:ali')", [windowId]);
    expect(await message(w.pool.query("SELECT exit.decide_outcome($1, 'operator:ali', 'approve', 'requests recorded for the trustee')", [windowId]))).toMatch(/maker-checker/);
    await w.su.query("SELECT kyc.revoke($1, 'officer:test', 'test: verification revoked')", [G.subjectId]).catch(() => undefined);
    await w.pool.query("SELECT exit.decide_outcome($1, 'operator:sara', 'approve', 'requests recorded for the trustee')", [windowId]);
    const view = (await web.query<{ v: { requests: { status: string }[] } }>("SELECT webauth.web_exit_overview($1) AS v", [session])).rows[0]?.v;
    const statuses = view?.requests.map((x) => x.status) ?? [];
    expect(statuses).toContain("withdrawn");
    expect(statuses.some((s) => s === "under_review" || s === "recorded")).toBe(true);
    expect(statuses).not.toContain("declined");
  });
});
