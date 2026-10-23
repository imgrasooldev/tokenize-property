import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exitCaseFixture, exitToken, exitWindowFixture, sha64 } from "../support/exit";
import { cast, createWorld, sha, token, verify, type Actor, type Cast, type World } from "../support/world";

/**
 * S-05 through the portal's own database functions (migration 0027): who may read exit cases and
 * windows, a maker opening a case and proposing a decision with a fresh step-up, deciders voting in
 * their capacity bound to the digest they reviewed, maker-checker and SoD refusals, and the window
 * decision. The rules themselves are covered in depth by backend/packages/exit/test.
 */
let w: World;
let c: Cast;
let counter = Date.now();
let tok = "";

type R = { ok: boolean; id?: number; status?: string; error?: string; state?: string };
interface Decision {
  id: number;
  code: string;
  status: string;
  digest: string;
  myCapacities: string[];
  votes: { capacity: string; officer: string; vote: string }[];
}
interface CaseView {
  id: number;
  state: string;
  openedBy: string;
  decisions: Decision[];
  possibleDecisions: { code: string }[];
  facts: Record<string, unknown>;
  caseDigest: string;
  me: { handle: string; conflicted: boolean };
}

async function fresh(a: Actor): Promise<void> {
  await w.portal.query("SELECT admin.record_step_up($1, $2, $3)", [a.sessionHash, a.credentialId, ++counter]);
}
async function view(a: Actor, id: number | string): Promise<CaseView> {
  const { rows } = await w.portal.query<{ v: CaseView | null }>("SELECT admin.exit_case($1, $2) AS v", [a.sessionHash, id]);
  if (!rows[0]?.v) throw new Error(`no exit case ${String(id)}`);
  return rows[0].v;
}
async function request(a: Actor, caseId: number | null, action: string, args: Record<string, unknown>, reason: string | null): Promise<R> {
  await fresh(a);
  const { rows } = await w.portal.query<{ r: R }>("SELECT admin.exit_request($1, $2, $3, $4::jsonb, $5) AS r", [a.sessionHash, caseId, action, JSON.stringify(args), reason]);
  return rows[0]?.r ?? { ok: false };
}
async function decide(a: Actor, kind: string, ref: number, decision: string, digest: string, args: Record<string, unknown> = {}): Promise<R> {
  await fresh(a);
  const { rows } = await w.portal.query<{ r: R }>("SELECT admin.exit_decide($1, $2, $3, $4, 'checked against the evidence on file', $5, $6::jsonb) AS r", [
    a.sessionHash,
    kind,
    ref,
    decision,
    Buffer.from(digest, "hex"),
    JSON.stringify(args),
  ]);
  return rows[0]?.r ?? { ok: false };
}
const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => (e as { code?: string }).code,
  );

beforeAll(async () => {
  w = await createWorld();
  c = await cast(w);
  tok = await exitToken(w.su, [
    { wallet: `0x${"e1".repeat(20)}`, units: 600n },
    { wallet: `0x${"e2".repeat(20)}`, units: 400n },
  ]);
});
afterAll(async () => {
  await w.drop();
});

describe("exit reads", () => {
  const READERS = ["ops_maker", "ops_checker", "compliance_officer", "legal_officer", "trustee_officer", "auditor"] as const;
  let caseId = "";
  let windowId = "";
  beforeAll(async () => {
    const other = await exitToken(w.su, [{ wallet: `0x${"e3".repeat(20)}`, units: 10n }]);
    caseId = await exitCaseFixture(w.su, other);
    windowId = await exitWindowFixture(w.su, tok);
  });

  it("operations, compliance, legal, trustee officers and auditors read; tax officers, administrators and no session are refused", async () => {
    for (const who of READERS) {
      // eslint-disable-next-line security/detect-object-injection
      const s = c[who].sessionHash;
      const o = await w.portal.query<{ v: { cases: { id: number }[]; windows: { id: number }[] } }>("SELECT admin.exit_overview($1) AS v", [s]);
      expect(o.rows[0]?.v.cases.map((x) => String(x.id)), who).toContain(caseId);
      expect(o.rows[0]?.v.windows.map((x) => String(x.id)), who).toContain(windowId);
      expect((await w.portal.query<{ v: unknown }>("SELECT admin.exit_case($1, $2) AS v", [s, caseId])).rows[0]?.v).not.toBeNull();
      expect((await w.portal.query<{ v: unknown }>("SELECT admin.exit_window($1, $2) AS v", [s, windowId])).rows[0]?.v).not.toBeNull();
    }
    for (const s of [c.tax_officer.sessionHash, c.admin.sessionHash, sha(token())]) {
      expect(await code(w.portal.query("SELECT admin.exit_overview($1)", [s]))).toBe("42501");
      expect(await code(w.portal.query("SELECT admin.exit_case($1, $2)", [s, caseId]))).toBe("42501");
      expect(await code(w.portal.query("SELECT admin.exit_window($1, $2)", [s, windowId]))).toBe("42501");
    }
    // Unknown items are NULL (the page answers "not found").
    expect((await w.portal.query<{ v: unknown }>("SELECT admin.exit_case($1, 999999) AS v", [c.auditor.sessionHash])).rows[0]?.v).toBeNull();
  });

  it("window requests show investors as an 8-digit reference only", async () => {
    const { rows } = await w.portal.query<{ v: unknown }>("SELECT admin.exit_window($1, $2) AS v", [c.auditor.sessionHash, windowId]);
    expect(JSON.stringify(rows[0]?.v)).not.toMatch(/cnic|iban|name/i);
  });
});

describe("an exit case through the portal", () => {
  let id = 0;
  let decision: Decision;

  it("an operations maker opens it with a fresh step-up, under the maker's handle; a stale step-up is refused", async () => {
    const args = {
      token: tok,
      offerPaisa: "150000000",
      valuationAPaisa: "140000000",
      valuationASha: sha64(),
      valuationBPaisa: "145000000",
      valuationBSha: sha64(),
      costsPaisa: "0",
      voteRequired: true,
    };
    await w.su.query("ALTER TABLE admin.sessions DISABLE TRIGGER sessions_guard");
    await w.su.query("UPDATE admin.sessions SET step_up_at = now() - interval '6 minutes' WHERE token_hash = $1", [c.ops_maker.sessionHash]);
    await w.su.query("ALTER TABLE admin.sessions ENABLE TRIGGER sessions_guard");
    expect(
      await code(w.portal.query("SELECT admin.exit_request($1, NULL, 'open', $2::jsonb, 'sale proposal from a qualified buyer')", [c.ops_maker.sessionHash, JSON.stringify(args)])),
    ).toBe("PTS01");
    const r = await request(c.ops_maker, null, "open", args, "sale proposal from a qualified buyer for the building");
    expect(r, r.error).toMatchObject({ ok: true, status: "proposed" });
    id = r.id ?? 0;
    const v = await view(c.auditor, id);
    expect(v.state).toBe("proposed");
    expect(v.openedBy).toBe(c.ops_maker.handle);
    expect(v.possibleDecisions.map((p) => p.code).sort()).toEqual(["X1", "X2", "X3"]);
    // Only operations makers open cases.
    expect(await code(w.portal.query("SELECT admin.exit_request($1, NULL, 'open', '{}', 'probe of the permission check')", [c.ops_checker.sessionHash]))).toBe("42501");
    // A second live case on the same token is refused (audited, returned).
    const again = await request(c.ops_maker, null, "open", { ...args, valuationASha: sha64(), valuationBSha: sha64() }, "a second proposal for the same token");
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/already has a live exit case/);
  });

  it("the maker proposes X2 (vote) with its evidence; invalid detail and X3 (vote required) are refused", async () => {
    const bad = await request(c.ops_maker, id, "propose", { code: "X2", detail: { minutesSha: "zz" } }, "committee recommends an investor vote");
    expect(bad).toMatchObject({ ok: false, state: "22023" });
    const x3 = await request(c.ops_maker, id, "propose", { code: "X3", detail: { minutesSha: sha64() } }, "committee recommends the sale");
    expect(x3.ok).toBe(false);
    expect(x3.error).toMatch(/require an investor vote/);
    const r = await request(c.ops_maker, id, "propose", { code: "X2", detail: { minutesSha: sha64(), noticeSha: sha64(), voteRecordBlock: "20" } }, "committee recommends an investor vote");
    expect(r, r.error).toMatchObject({ ok: true, status: "open" });
    const v = await view(c.ops_checker, id);
    decision = v.decisions.find((d) => d.status === "open") as Decision;
    expect(decision.code).toBe("X2");
    expect(decision.myCapacities).toEqual(["ops_checker"]);
    expect((await view(c.legal_officer, id)).decisions[0]?.myCapacities).toEqual([]);
  });

  it("the proposer cannot vote (no decide permission), the auditor reads but cannot decide, a stale digest is refused", async () => {
    for (const a of [c.ops_maker, c.auditor, c.tax_officer]) {
      await fresh(a);
      expect(
        await code(w.portal.query("SELECT admin.exit_decide($1, 'vote', $2, 'approve', 'probe of the permission check', $3, '{}')", [a.sessionHash, decision.id, Buffer.from(decision.digest, "hex")])),
      ).toBe("42501");
    }
    expect((await view(c.auditor, id)).decisions).toHaveLength(1);
    const stale = await decide(c.ops_checker, "vote", decision.id, "approve", "ab".repeat(32));
    expect(stale.ok).toBe(false);
    expect(stale.error).toMatch(/changed since you reviewed it/);
    // A legal officer holds no capacity on X2.
    const legal = await decide(c.legal_officer, "vote", decision.id, "approve", decision.digest);
    expect(legal.ok).toBe(false);
    expect(legal.error).toMatch(/no capacity that is still open/);
  });

  it("the operations checker and a compliance officer approve in their capacities: the vote opens", async () => {
    const first = await decide(c.ops_checker, "vote", decision.id, "approve", decision.digest);
    expect(first, first.error).toMatchObject({ ok: true, status: "open" });
    const twice = await decide(c.ops_checker, "vote", decision.id, "approve", decision.digest);
    expect(twice.ok).toBe(false);
    expect(twice.error).toMatch(/already decided this/);
    // The digest covers the votes so far: what the compliance officer saw before the first vote is stale now.
    const old = await decide(c.compliance_officer, "vote", decision.id, "approve", decision.digest);
    expect(old.error).toMatch(/changed since you reviewed it/);
    const now = (await view(c.compliance_officer, id)).decisions.find((d) => d.id === decision.id);
    expect(now?.myCapacities).toEqual(["compliance_officer"]);
    const second = await decide(c.compliance_officer, "vote", decision.id, "approve", now?.digest ?? "");
    expect(second, second.error).toMatchObject({ ok: true, status: "approved" });
    const v = await view(c.auditor, id);
    expect(v.state).toBe("vote_open");
    expect(v.facts.voteRecordBlock).toBe(20);
    expect(v.decisions[0]?.votes.map((x) => `${x.capacity}:${x.officer}`).sort()).toEqual([`compliance_officer:${c.compliance_officer.handle}`, `ops_checker:${c.ops_checker.handle}`]);
    const events = await w.su.query<{ code: string; actor: string }>("SELECT code, actor FROM exit.case_events WHERE case_id = $1", [id]);
    expect(events.rows).toEqual([{ code: "X2", actor: c.compliance_officer.handle }]);
  });

  it("an officer who declares a conflict decides nothing more on the case", async () => {
    const v = await view(c.trustee_officer, id);
    const r = await decide(c.trustee_officer, "conflict", id, "declare", v.caseDigest);
    expect(r, r.error).toMatchObject({ ok: true, status: "declared" });
    expect((await view(c.trustee_officer, id)).me.conflicted).toBe(true);
    // The vote result (X4/X5) waits for the notice period anyway; the conflict is what the trustee sees.
    const again = await decide(c.trustee_officer, "conflict", id, "declare", (await view(c.trustee_officer, id)).caseDigest);
    expect(again.ok).toBe(false);
  });

  it("the audit chains are intact", async () => {
    expect((await w.su.query("SELECT * FROM exit.verify_audit()")).rows).toEqual([]);
    expect(await verify(w)).toEqual([]);
    const actions = (await w.su.query<{ action: string }>("SELECT action FROM admin.audit WHERE action LIKE 'exit.%'")).rows.map((r) => r.action);
    expect(actions).toContain("exit.requested");
    expect(actions).toContain("exit.decided");
  });
});

describe("a redemption window through the portal", () => {
  it("a maker proposes, the checker approves (cap fixed); the maker and a trustee officer cannot decide it", async () => {
    const t = await exitToken(w.su, [{ wallet: `0x${"e4".repeat(20)}`, units: 5000n }]);
    const opensAt = new Date(Date.now() + 3600_000).toISOString();
    const closesAt = new Date(Date.now() + 3 * 86400_000).toISOString();
    const r = await request(c.ops_maker, null, "window", { token: t, opensAt, closesAt, navPerUnitPaisa: "100000", navSha: sha64(), discountPpm: 50000 }, "quarterly redemption window");
    expect(r, r.error).toMatchObject({ ok: true, status: "proposed" });
    const id = r.id ?? 0;
    const digest = async () => (await w.portal.query<{ v: { digest: string } }>("SELECT admin.exit_window($1, $2) AS v", [c.ops_checker.sessionHash, id])).rows[0]?.v.digest ?? "";
    const trustee = await decide(c.trustee_officer, "window", id, "approve", await digest());
    expect(trustee.ok).toBe(false);
    expect(trustee.error).toMatch(/only an operations checker/);
    expect(await code(w.portal.query("SELECT admin.exit_decide($1, 'window', $2, 'approve', 'probe of the permission check', $3, '{}')", [c.ops_maker.sessionHash, id, Buffer.from(await digest(), "hex")]))).toBe("42501");
    const ok = await decide(c.ops_checker, "window", id, "approve", await digest());
    expect(ok, ok.error).toMatchObject({ ok: true, status: "approved" });
    const v = (await w.portal.query<{ v: { status: string; capUnits: string; pricePerUnitPaisa: string; decidedBy: string } }>("SELECT admin.exit_window($1, $2) AS v", [c.auditor.sessionHash, id]))
      .rows[0]?.v;
    expect(v).toMatchObject({ status: "approved", capUnits: "500", pricePerUnitPaisa: "95000", decidedBy: c.ops_checker.handle });
    // The outcome is proposed only after the window closes.
    const early = await request(c.ops_maker, null, "outcome", { windowId: id }, null);
    expect(early.ok).toBe(false);
    expect(early.error).toMatch(/still open/);
  });

  it("refresh from chain is the maker's (exit.tick)", async () => {
    expect((await w.portal.query<{ v: { ok: boolean } }>("SELECT admin.exit_sync($1) AS v", [c.ops_maker.sessionHash])).rows[0]?.v.ok).toBe(true);
    expect(await code(w.portal.query("SELECT admin.exit_sync($1)", [c.ops_checker.sessionHash]))).toBe("42501");
  });
});
