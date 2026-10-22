import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { operationsWorld, type OperationsWorld } from "../support/operations";
import { distribution, hex, holding, readModelToken, type TestToken } from "../support/trustee";
import { cast, createWorld, invite, verify, type Actor, type Cast, type World } from "../support/world";

/**
 * Step 6d database rules (migration 0023) through the portal's own login: the portal reaches the
 * trustee schema only through admin.*; every decision needs a fresh step-up and the digest of what
 * was shown; only trustee officers decide; a distribution is reviewed once, inside its 48-hour
 * window, an approval needs the recomputed Merkle root and a rejection blocks its payout batch and
 * its ledger booking; register adjustments need a second trustee officer and never make a balance
 * negative; the register is compared with the read model; exports are recorded; the trustee chain
 * verifies and finds rows written around the API.
 */
let w: World;
let c: Cast;
let t2: Actor;
let tok: TestToken;
let counter = Date.now();
type R = { ok: boolean; id?: number; status?: string; error?: string };

beforeAll(async () => {
  w = await createWorld();
  c = await cast(w);
  t2 = await invite(w, c.admin, c.admin2, "trustee.two", "trustee_officer");
  tok = await readModelToken(w.su, { supply: 0n, cap: 1_000_000n });
});
afterAll(async () => {
  await w.drop();
});

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

async function stepUp(a: Actor, stale = false): Promise<void> {
  await w.portal.query("SELECT admin.record_step_up($1, $2, $3)", [a.sessionHash, a.credentialId, ++counter]);
  if (stale) {
    await w.su.query("ALTER TABLE admin.sessions DISABLE TRIGGER sessions_guard");
    await w.su.query("UPDATE admin.sessions SET step_up_at = step_up_at - interval '5 minutes 1 second' WHERE token_hash = $1", [a.sessionHash]);
    await w.su.query("ALTER TABLE admin.sessions ENABLE TRIGGER sessions_guard");
  }
}

async function one<T>(sql: string, params: unknown[]): Promise<T> {
  const { rows } = await w.portal.query<{ r: T }>(sql, params);
  return rows[0]?.r as T;
}

async function review(a: Actor, id: number, decision: "approve" | "reject", root: string | null, digest?: Buffer): Promise<R> {
  const d = await one<{ digest: string }>("SELECT admin.trustee_distribution($1, $2, $3) AS r", [a.sessionHash, tok.registry, id]);
  await stepUp(a);
  return one<R>("SELECT admin.review_distribution($1, $2, $3, $4, 'recomputed from the record block and statement', $5, $6) AS r", [
    a.sessionHash,
    tok.registry,
    id,
    decision,
    digest ?? Buffer.from(d.digest, "hex"),
    root,
  ]);
}

describe("the portal reaches the trustee schema only through admin.*", () => {
  it("its role cannot read trustee tables or call trustee.* functions", async () => {
    for (const sql of [
      "SELECT * FROM trustee.audit",
      "SELECT * FROM trustee.register_entries",
      "SELECT * FROM trustee.distribution_reviews",
      `SELECT trustee.review_distribution('0x${"1".repeat(40)}', 1, 'trustee.one', 'reject', 'portal trying directly', '\\x00', NULL)`,
      `SELECT trustee.propose_adjustment('0x${"1".repeat(40)}', '0x${"2".repeat(40)}', 1, '\\x00', 'portal trying directly', 'trustee.one')`,
      "SELECT * FROM signer.trustee_cosign_kinds",
    ]) {
      expect(await code(w.portal.query(sql)), sql).toBe("42501");
    }
  });
});

describe("rent distribution review (S-03 D4/D6)", () => {
  it("only trustee officers decide, with a fresh step-up, the digest shown and, to approve, the recomputed root", async () => {
    const d = await distribution(w.su, tok, 1);
    expect(await code(review(c.auditor, d.id, "reject", null))).toBe("42501");
    expect(await code(review(c.ops_checker, d.id, "reject", null))).toBe("42501");
    await stepUp(c.trustee_officer, true);
    const view = await one<{ digest: string; blockers: string[] }>("SELECT admin.trustee_distribution($1, $2, 1) AS r", [c.trustee_officer.sessionHash, tok.registry]);
    expect(view.blockers).toEqual([]);
    expect(
      await code(
        w.portal.query("SELECT admin.review_distribution($1, $2, 1, 'reject', 'reason long enough here', $3, NULL)", [
          c.trustee_officer.sessionHash,
          tok.registry,
          Buffer.from(view.digest, "hex"),
        ]),
      ),
    ).toBe("PTS01");
    expect(await review(c.trustee_officer, d.id, "approve", hex(32))).toMatchObject({ ok: false, error: expect.stringMatching(/recomputed Merkle root differs/) as unknown });
    expect(await review(c.trustee_officer, d.id, "approve", d.root, Buffer.alloc(32, 9))).toMatchObject({ ok: false, error: expect.stringMatching(/differs from what you reviewed/) as unknown });
    expect(await review(c.trustee_officer, d.id, "approve", d.root.toUpperCase().replace("0X", "0x"))).toMatchObject({ ok: true, status: "approved" });
    // One decision per distribution.
    expect(await review(t2, d.id, "reject", null)).toMatchObject({ ok: false, error: expect.stringMatching(/already decided/) as unknown });
    expect(await one<string | null>("SELECT trustee.distribution_blocked($1, 1) AS r", [tok.token]).catch(() => "no access")).toBe("no access");
  });

  it("outside the 48-hour window or once not published, nothing can be decided", async () => {
    const late = await distribution(w.su, tok, 2, { hoursAgo: 49 });
    expect(await review(c.trustee_officer, late.id, "reject", null)).toMatchObject({ ok: false, error: expect.stringMatching(/48-hour review window closed/) as unknown });
    const fin = await distribution(w.su, tok, 3, { status: "finalized", hoursAgo: 50 });
    expect(await review(c.trustee_officer, fin.id, "reject", null)).toMatchObject({ ok: false, error: expect.stringMatching(/finalized on chain/) as unknown });
    const v = await one<{ blockers: string[] }>("SELECT admin.trustee_distribution($1, $2, 2) AS r", [c.trustee_officer.sessionHash, tok.registry]);
    expect(v.blockers.join(" ")).toMatch(/window closed/);
  });

  it("a rejection blocks the payout batch and the ledger booking of that distribution in the database", async () => {
    const d = await distribution(w.su, tok, 4);
    expect(await review(t2, d.id, "reject", null)).toMatchObject({ ok: true, status: "rejected" });
    const blocked = (await w.su.query<{ r: string | null }>("SELECT trustee.distribution_blocked($1, 4) AS r", [tok.token])).rows[0]?.r;
    expect(blocked).toMatch(/trustee rejected distribution 4/);
    await expect(
      w.su.query(
        `INSERT INTO bank.payout_batches (reference, token, distribution_id, total_paisa, item_count, items_digest, created_by)
         VALUES ('PTPAY-TEST-REJECTED', $1, 4, 1500000, 1, $2, 'operator:maker')`,
        [tok.token, randomBytes(32)],
      ),
    ).rejects.toThrow(/payout refused: the trustee rejected/);
    await expect(
      w.su.query(
        `INSERT INTO ledger.journal (idempotency_key, kind, created_by, created_at, payload_hash, prev_hash, hash)
         VALUES ($1, 'rent_distribution', 'test', now(), $2, $2, $3)`,
        [`rent:distribution:${tok.token}:4`, randomBytes(32), randomBytes(32)],
      ),
    ).rejects.toThrow(/booking refused: the trustee rejected/);
    // The approved distribution 1 is not blocked.
    expect((await w.su.query<{ r: string | null }>("SELECT trustee.distribution_blocked($1, 1) AS r", [tok.token])).rows[0]?.r).toBeNull();
    const dash = await one<{ rejectedNotOnChain: number }>("SELECT admin.trustee_dashboard($1) AS r", [c.auditor.sessionHash]);
    expect(dash.rejectedNotOnChain).toBe(1);
  });
});

describe("the trustee register (T-4)", () => {
  const wallet = hex(20);
  async function propose(a: Actor, units: string): Promise<R> {
    await stepUp(a);
    return one<R>("SELECT admin.propose_register_adjustment($1, $2, $3, $4, $5, 'opening balance from the trustee register extract') AS r", [
      a.sessionHash,
      tok.token,
      wallet,
      units,
      "ab".repeat(32),
    ]);
  }
  async function decide(a: Actor, id: number, decision: "approve" | "reject", digest?: Buffer): Promise<R> {
    const v = await one<{ digest: string }>("SELECT admin.register_adjustment($1, $2) AS r", [a.sessionHash, id]);
    await stepUp(a);
    return one<R>("SELECT admin.decide_register_adjustment($1, $2, $3, 'checked against the evidence file', $4) AS r", [a.sessionHash, id, decision, digest ?? Buffer.from(v.digest, "hex")]);
  }

  it("an adjustment needs a second trustee officer and the digest; the register is compared with the read model", async () => {
    const p = await propose(c.trustee_officer, "100");
    expect(p).toMatchObject({ ok: true, status: "open" });
    const id = p.id ?? 0;
    expect(await decide(c.trustee_officer, id, "approve")).toMatchObject({ ok: false, error: expect.stringMatching(/different trustee officer/) as unknown });
    expect(await decide(t2, id, "approve", Buffer.alloc(32, 3))).toMatchObject({ ok: false, error: expect.stringMatching(/differs/) as unknown });
    // Only one open adjustment per wallet.
    expect(await propose(t2, "5")).toMatchObject({ ok: false, error: expect.stringMatching(/already open/) as unknown });
    expect(await decide(t2, id, "approve")).toMatchObject({ ok: true, status: "approved" });

    type View = { registerTotal: string; differences: number; pinned: { block: number } | null; lines: { wallet: string; register: string; chain: string; difference: string }[] };
    let v = await one<View>("SELECT admin.trustee_register($1, $2, 100) AS r", [c.auditor.sessionHash, tok.token]);
    expect(v).toMatchObject({ registerTotal: "100", differences: 1 });
    expect(v.pinned).not.toBeNull();
    expect(v.lines).toEqual([{ wallet, register: "100", chain: "0", difference: "-100" }]);
    await holding(w.su, tok, wallet, 100n);
    const stranger = hex(20);
    await holding(w.su, tok, stranger, 7n);
    v = await one<View>("SELECT admin.trustee_register($1, $2, 100) AS r", [c.auditor.sessionHash, tok.token]);
    // Differences first: the stranger on chain without a register entry.
    expect(v.differences).toBe(1);
    expect(v.lines[0]).toEqual({ wallet: stranger, register: "0", chain: "7", difference: "7" });
    expect(v.lines[1]).toEqual({ wallet, register: "100", chain: "100", difference: "0" });
  });

  it("no balance goes negative; expired adjustments cannot be decided; only trustee officers propose", async () => {
    expect(await propose(c.trustee_officer, "-150")).toMatchObject({ ok: false, error: expect.stringMatching(/below zero/) as unknown });
    expect(await code(propose(c.auditor, "5"))).toBe("42501");
    const p = await propose(c.trustee_officer, "-40");
    expect(p.ok).toBe(true);
    await w.su.query("ALTER TABLE trustee.adjustments DISABLE TRIGGER adjustments_guard");
    await w.su.query("ALTER TABLE trustee.adjustments DISABLE TRIGGER adjustments_officer_binding");
    await w.su.query("UPDATE trustee.adjustments SET proposed_at = proposed_at - interval '73 hours', expires_at = expires_at - interval '73 hours' WHERE id = $1", [p.id]);
    await w.su.query("ALTER TABLE trustee.adjustments ENABLE TRIGGER adjustments_guard");
    await w.su.query("ALTER TABLE trustee.adjustments ENABLE TRIGGER adjustments_officer_binding");
    const v = await one<{ blockers: string[]; digest: string }>("SELECT admin.register_adjustment($1, $2) AS r", [t2.sessionHash, p.id]);
    expect(v.blockers.join(" ")).toMatch(/older than 72 hours/);
    expect(await decide(t2, p.id ?? 0, "approve", Buffer.from(v.digest, "hex"))).toMatchObject({ ok: true, status: "expired" });
  });

  it("a register export is recorded in the trustee and admin audits before release", async () => {
    const r = await one<{ ok: boolean; trusteeAuditId: number; auditId: number; auditHash: string }>(
      "SELECT admin.record_register_export($1, $2, 5, 2, $3) AS r",
      [c.auditor.sessionHash, tok.token, "cd".repeat(32)],
    );
    expect(r).toMatchObject({ ok: true });
    const a = await w.su.query<{ action: string; detail: { sha256: string; block: number } }>("SELECT action, detail FROM trustee.audit WHERE id = $1", [r.trusteeAuditId]);
    expect(a.rows[0]).toMatchObject({ action: "register.exported", detail: { sha256: "cd".repeat(32), block: 5 } });
    expect(await code(w.portal.query("SELECT admin.record_register_export($1, $2, 5, 2, 'not-a-hash')", [c.auditor.sessionHash, tok.token]))).toBe("23514");
  });
});

describe("S-03 trustee duties on the operations path (T-8)", () => {
  let ow: OperationsWorld;
  beforeAll(async () => {
    ow = await operationsWorld(w.su, [{ wallet: hex(20), units: 10n }]);
  });

  async function chargeOf(id: string, a: Actor): Promise<{ digest: string; blockers: string[] }> {
    return one<{ digest: string; blockers: string[] }>("SELECT admin.trustee_charge($1, $2) AS r", [a.sessionHash, id]);
  }

  it("OP-21: a charge above the operations limit needs the trustee before the operations checker", async () => {
    // A low limit (Rs 10,000) so the rent in the pool covers the charge; the setting change is audited by 0021.
    await w.su.query("UPDATE ops.settings SET value = '1000000'::jsonb WHERE key = 'expense_ops_limit_paisa'");
    const big = (await w.su.query<{ id: string }>(
      "SELECT ops.propose_charge($1, '2026-10', 'expense', NULL, 'roof-co', 'roof repair, tower A', 5000000, $2, 'operator:ali') AS id",
      [ow.token, createHash("sha256").update("roof invoice").digest()],
    )).rows[0]?.id ?? "";
    const opsView = async () => one<{ digest: string; blockers: { approve: string[] } }>("SELECT admin.operations_charge($1, $2) AS r", [c.ops_checker.sessionHash, big]);
    expect((await opsView()).blockers.approve.join(" ")).toMatch(/trustee approves it first/);
    await stepUp(c.ops_checker);
    const early = await one<R>("SELECT admin.decide_charge($1, $2, 'approve', 'invoice checked against the budget', $3) AS r", [c.ops_checker.sessionHash, big, Buffer.from((await opsView()).digest, "hex")]);
    expect(early).toMatchObject({ ok: false, error: expect.stringMatching(/trustee approves it first/) as unknown });
    // Only trustee officers decide for the trustee; the digest of what was shown is bound.
    expect(await code(w.portal.query("SELECT admin.decide_trustee_charge($1, $2, 'approve', 'reason long enough', $3)", [c.ops_checker.sessionHash, big, randomBytes(32)]))).toBe("42501");
    const v = await chargeOf(big, c.trustee_officer);
    expect(v.blockers).toEqual([]);
    await stepUp(c.trustee_officer);
    expect(await one<R>("SELECT admin.decide_trustee_charge($1, $2, 'approve', 'capital expense within the budget line', $3) AS r", [c.trustee_officer.sessionHash, big, randomBytes(32)]))
      .toMatchObject({ ok: false, error: expect.stringMatching(/differs/) as unknown });
    expect(await one<R>("SELECT admin.decide_trustee_charge($1, $2, 'approve', 'capital expense within the budget line', $3) AS r", [c.trustee_officer.sessionHash, big, Buffer.from(v.digest, "hex")]))
      .toEqual({ ok: true, status: "approved" });
    expect(await one<R>("SELECT admin.decide_trustee_charge($1, $2, 'reject', 'second thoughts are not allowed', $3) AS r", [t2.sessionHash, big, Buffer.from(v.digest, "hex")]))
      .toMatchObject({ ok: false });
    await stepUp(c.ops_checker);
    expect(await one<R>("SELECT admin.decide_charge($1, $2, 'approve', 'invoice checked against the budget', $3) AS r", [c.ops_checker.sessionHash, big, Buffer.from((await opsView()).digest, "hex")]))
      .toEqual({ ok: true, status: "approved" });
    // A charge within the limit needs no trustee.
    const smallId = (await w.su.query<{ id: string }>(
      "SELECT ops.propose_charge($1, '2026-10', 'expense', NULL, 'acme-repairs', 'door lock, tower B', 500000, $2, 'operator:ali') AS id",
      [ow.token, createHash("sha256").update("lock invoice").digest()],
    )).rows[0]?.id ?? "";
    await stepUp(c.trustee_officer);
    const small = await chargeOf(smallId, c.trustee_officer);
    expect(small.blockers.join(" ")).toMatch(/no trustee approval is needed/);
    expect(await one<R>("SELECT admin.decide_trustee_charge($1, $2, 'approve', 'not needed for this one', $3) AS r", [c.trustee_officer.sessionHash, smallId, Buffer.from(small.digest, "hex")]))
      .toMatchObject({ ok: false, error: expect.stringMatching(/within the operations limit/) as unknown });
  });

  it("D4: the pre-check is for an attached statement; approval of a calculation needs it (also against a direct UPDATE)", async () => {
    const v = await one<{ digest: string; blockers: string[]; status: string }>("SELECT admin.trustee_calculation($1, $2) AS r", [c.trustee_officer.sessionHash, ow.distributionId]);
    expect(v.status).toBe("calculated");
    expect(v.blockers.join(" ")).toMatch(/attached statement/);
    await stepUp(c.trustee_officer);
    expect(await one<R>("SELECT admin.precheck_distribution($1, $2, 'reject', 'statement not attached yet', $3, NULL) AS r", [c.trustee_officer.sessionHash, ow.distributionId, Buffer.from(v.digest, "hex")]))
      .toMatchObject({ ok: false, error: expect.stringMatching(/calculated/) as unknown });
    expect((await w.su.query<{ p: string }>("SELECT trustee.calculation_problem($1) AS p", [ow.distributionId])).rows[0]?.p).toMatch(/not pre-checked/);
  });

  it("a rejected on-chain distribution also blocks S-03's withholding journal; recovery cases reach the trustee read-only", async () => {
    const d = await distribution(w.su, tok, 5);
    expect(await review(c.trustee_officer, d.id, "reject", null)).toMatchObject({ ok: true, status: "rejected" });
    await expect(
      w.su.query(
        `INSERT INTO ledger.journal (idempotency_key, kind, created_by, created_at, payload_hash, prev_hash, hash)
         VALUES ($1, 'rent_wht', 'test', now(), $2, $2, $3)`,
        [`rent:wht:${tok.token}:5`, randomBytes(32), randomBytes(32)],
      ),
    ).rejects.toThrow(/booking refused: the trustee rejected/);
    const r = await one<{ cases: unknown }>("SELECT admin.trustee_recoveries($1) AS r", [c.auditor.sessionHash]);
    expect(Array.isArray(r.cases)).toBe(true);
  });
});

describe("the trustee audit chain (T-6)", () => {
  it("is readable in the audit viewer, verifies, and finds edits and rows written around the API", async () => {
    const rows = await w.portal.query<{ action: string }>("SELECT * FROM admin.audit_rows($1, 'trustee', NULL, NULL, NULL, NULL, NULL, 100)", [c.trustee_officer.sessionHash]);
    expect(rows.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["distribution.reviewed", "adjustment.proposed", "adjustment.decided", "register.entered", "register.exported"]));
    expect((await w.su.query("SELECT * FROM trustee.verify_audit()")).rows).toEqual([]);
    expect(await verify(w)).toEqual([]);
    // Refusals are audited in the admin chain.
    const refused = await w.su.query<{ n: string }>("SELECT count(*) AS n FROM admin.audit WHERE action = 'approval.refused' AND detail->>'kind' LIKE 'trustee.%'");
    expect(Number(refused.rows[0]?.n)).toBeGreaterThan(3);

    // A register entry written around the API, and an edited audit entry.
    await w.su.query("INSERT INTO trustee.register_entries (token, wallet, units, source, source_ref, entered_by) VALUES ($1, $2, 5, 'adjustment', 'adjustment:999999', 'dba')", [tok.token, hex(20)]);
    await w.su.query("ALTER TABLE trustee.audit DISABLE TRIGGER audit_append_only");
    await w.su.query("UPDATE trustee.audit SET detail = detail || '{\"reason\":\"edited\"}' WHERE id = (SELECT min(id) FROM trustee.audit)");
    await w.su.query("ALTER TABLE trustee.audit ENABLE TRIGGER audit_append_only");
    const problems = (await w.su.query<{ problem: string }>("SELECT problem FROM trustee.verify_audit()")).rows.map((p) => p.problem).join("\n");
    expect(problems).toMatch(/content does not match its hash/);
    expect(problems).toMatch(/register entry \d+ has no matching audit entry/);
    expect(problems).toMatch(/register entry \d+: adjustment not approved/);
  });
});
