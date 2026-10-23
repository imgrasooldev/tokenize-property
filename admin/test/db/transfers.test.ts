import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agreement, party, PRICE, TRANSFER_TOKEN, transferWorld, type Party } from "../support/transfers";
import { cast, createWorld, invite, type Actor, type Cast, type World } from "../support/world";

/**
 * S-04 phase 0 through the portal's own database functions (migration 0028): who may open,
 * complete, decide, cancel and run the cash leg, with a fresh step-up, bound to the digest the
 * officer reviewed; refusals audited; surveillance alerts only for compliance officers and auditors
 * (tipping-off). The rules themselves are covered in depth by backend/packages/transfer/test.
 */
let w: World;
let c: Cast;
let compliance2: Actor;
let counter = Date.now() + 9_000_000;

type R = { ok: boolean; id?: number; status?: string; error?: string };
interface Detail {
  id: number;
  status: string;
  digest: string;
  myCapacities: string[];
  liveChecks: { code: string; ok: boolean; detail: string }[] | null;
  checks: { stage: string; passed: boolean } | null;
  decisions: { capacity: string; officer: string; decision: string }[];
  alerts: { rule: string; strCase: number }[] | null;
  payment: { code: string; escrowPaisa: string } | null;
  commands: { propose: { kind: string; status: string } | null };
  seller: { cnic: string; ref: string } | null;
  blockers: { maker: string[]; decide: string[]; cancel: string[]; dispute: string[]; prepare: string[]; confirm: string[] };
}

async function fresh(a: Actor): Promise<void> {
  await w.portal.query("SELECT admin.record_step_up($1, $2, $3)", [a.sessionHash, a.credentialId, ++counter]);
}
async function detail(a: Actor, id: number): Promise<Detail> {
  const { rows } = await w.portal.query<{ v: Detail }>("SELECT admin.transfer_case($1, $2) AS v", [a.sessionHash, id]);
  if (!rows[0]?.v) throw new Error(`no case ${String(id)}`);
  return rows[0].v;
}
async function act(a: Actor, id: number, action: string, capacity: string | null = null, reason = "checked the file against the records"): Promise<R> {
  await fresh(a);
  const d = await detail(a, id);
  const { rows } = await w.portal.query<{ r: R }>("SELECT admin.transfer_act($1, $2, $3, $4, $5, $6) AS r", [a.sessionHash, id, action, capacity, reason, Buffer.from(d.digest, "hex")]);
  return rows[0]?.r ?? { ok: false };
}
async function open(a: Actor, seller: Party, buyer: Party, units: number, consideration = "sale", price: bigint | null = PRICE): Promise<R> {
  await fresh(a);
  const { rows } = await w.portal.query<{ r: R }>("SELECT admin.transfer_open($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, NULL) AS r", [
    a.sessionHash,
    seller.subjectId,
    buyer.subjectId,
    TRANSFER_TOKEN,
    units,
    consideration,
    price === null ? null : price.toString(),
    consideration === "sale" ? null : "a gift between relatives for a wedding",
    agreement(),
  ]);
  return rows[0]?.r ?? { ok: false };
}
const code = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => "ok",
    (e: unknown) => (e as { code?: string }).code ?? "?",
  );
async function refusals(since: number): Promise<string[]> {
  const { rows } = await w.su.query<{ detail: { kind: string; error: string } }>("SELECT detail FROM admin.audit WHERE id > $1 AND action = 'approval.refused' ORDER BY id", [since]);
  return rows.filter((r) => r.detail.kind === "transfer").map((r) => r.detail.error);
}
const lastAudit = async (): Promise<number> => Number((await w.su.query<{ m: string }>("SELECT coalesce(max(id), 0) AS m FROM admin.audit")).rows[0]?.m ?? 0);

beforeAll(async () => {
  w = await createWorld();
  c = await cast(w);
  compliance2 = await invite(w, c.admin, c.admin2, "xfer.compliance.two", "compliance_officer");
  await transferWorld(w.su);
});
afterAll(async () => {
  await w.drop();
});

describe("a sale through the portal: desk, compliance, trustee", () => {
  let seller: Party;
  let buyer: Party;
  let id = 0;

  it("only an operations maker opens it, with a fresh step-up; bad terms come back refused and audited", async () => {
    seller = await party(w.su, 1000n);
    buyer = await party(w.su);
    // Other roles never reach the function's body (permission transfer.request).
    for (const a of [c.ops_checker, c.compliance_officer, c.trustee_officer, c.auditor]) {
      await fresh(a);
      expect(await code(w.portal.query("SELECT admin.transfer_open($1, $2, $3, $4, 10, 'sale', 100, NULL, $5, NULL, NULL)", [a.sessionHash, seller.subjectId, buyer.subjectId, TRANSFER_TOKEN, agreement()]))).toBe("42501");
    }
    // A stale step-up is refused by the database itself.
    await fresh(c.ops_maker);
    await w.su.query("ALTER TABLE admin.sessions DISABLE TRIGGER sessions_guard");
    await w.su.query("UPDATE admin.sessions SET step_up_at = step_up_at - interval '6 minutes' WHERE token_hash = $1", [c.ops_maker.sessionHash]);
    await w.su.query("ALTER TABLE admin.sessions ENABLE TRIGGER sessions_guard");
    expect(await code(w.portal.query("SELECT admin.transfer_open($1, $2, $3, $4, 10, 'sale', 100, NULL, $5, NULL, NULL)", [c.ops_maker.sessionHash, seller.subjectId, buyer.subjectId, TRANSFER_TOKEN, agreement()]))).toBe("PTS01");
    const since = await lastAudit();
    await fresh(c.ops_maker);
    const bad = await w.portal.query<{ r: R }>("SELECT admin.transfer_open($1, $2, $3, $4, 10, 'sale', 100, NULL, 'not-a-hash', NULL, NULL) AS r", [c.ops_maker.sessionHash, seller.subjectId, buyer.subjectId, TRANSFER_TOKEN]);
    expect(bad.rows[0]?.r).toMatchObject({ ok: false, error: expect.stringMatching(/SHA-256/) as unknown });
    expect((await open(c.ops_maker, seller, seller, 10)).error).toMatch(/two different investors/);
    expect(await refusals(since)).toHaveLength(2);
    const r = await open(c.ops_maker, seller, buyer, 100);
    expect(r).toMatchObject({ ok: true, status: "requested" });
    id = r.id ?? 0;
    const row = await w.su.query<{ opened_by: string; origin: string; accepted: boolean }>("SELECT opened_by, origin, accepted_at IS NOT NULL AS accepted FROM transfer.cases WHERE id = $1", [id]);
    expect(row.rows[0]).toEqual({ opened_by: c.ops_maker.handle, origin: "desk", accepted: true });
  });

  it("the detail explains in advance who may do what; the parties are masked", async () => {
    const asMaker = await detail(c.ops_maker, id);
    expect(asMaker.blockers.maker).toEqual([]);
    expect(asMaker.blockers.decide.join(" ")).toMatch(/Only compliance and trustee officers decide/);
    expect(asMaker.myCapacities).toEqual([]);
    const asComp = await detail(c.compliance_officer, id);
    expect(asComp.myCapacities).toEqual(["compliance"]);
    expect(asComp.blockers.maker.join(" ")).toMatch(/Only an operations maker/);
    expect(asComp.blockers.decide.join(" ")).toMatch(/The case is requested/);
    expect(asComp.seller?.cnic).toMatch(/^\*{5}-\*{4}\d{3}-\d$/);
    expect((await detail(c.trustee_officer, id)).myCapacities).toEqual(["trustee"]);
    expect(asComp.blockers.prepare.join(" ")).toMatch(/Only an operations maker prepares/);
  });

  it("the desk completes it (T1): checks recorded, every live check passes", async () => {
    expect(await act(c.compliance_officer, id, "complete").catch((e: unknown) => (e as { code?: string }).code)).toBe("42501");
    expect(await act(c.ops_maker, id, "complete")).toMatchObject({ ok: true, status: "checks" });
    const d = await detail(c.compliance_officer, id);
    expect(d.checks).toMatchObject({ stage: "complete", passed: true });
    expect(d.liveChecks?.filter((k) => !k.ok)).toEqual([]);
    expect((await detail(c.ops_maker, id)).blockers.maker.join(" ")).toMatch(/The case is checks/);
    const row = await w.su.query<{ completed_by: string }>("SELECT completed_by FROM transfer.cases WHERE id = $1", [id]);
    expect(row.rows[0]?.completed_by).toBe(c.ops_maker.handle);
  });

  it("maker-checker: the desk cannot decide; a decision is bound to the digest and the capacity; never twice per capacity", async () => {
    expect(await act(c.ops_maker, id, "approve", "compliance").catch((e: unknown) => (e as { code?: string }).code)).toBe("42501");
    expect(await act(c.ops_checker, id, "approve", "compliance").catch((e: unknown) => (e as { code?: string }).code)).toBe("42501");
    const since = await lastAudit();
    await fresh(c.compliance_officer);
    const forged = await w.portal.query<{ r: R }>("SELECT admin.transfer_act($1, $2, 'approve', 'compliance', 'all checks reviewed in full', $3) AS r", [c.compliance_officer.sessionHash, id, Buffer.alloc(32)]);
    expect(forged.rows[0]?.r.error).toMatch(/differs from what you reviewed/);
    expect((await act(c.compliance_officer, id, "approve", "trustee")).error).toMatch(/trustee_officer/);
    expect(await act(c.compliance_officer, id, "approve", "compliance")).toMatchObject({ ok: true, status: "checks" });
    expect((await act(c.compliance_officer, id, "approve", "compliance")).error).toMatch(/already decided/);
    expect((await act(compliance2, id, "approve", "compliance")).error).toMatch(/already taken/);
    expect((await detail(compliance2, id)).blockers.decide.join(" ")).toMatch(/Your capacity has already decided/);
    expect(await refusals(since)).toHaveLength(4);
  });

  it("the trustee's approval moves it to awaiting_cash with a payment code into escrow; nothing proposed before the money", async () => {
    expect(await act(c.trustee_officer, id, "approve", "trustee")).toMatchObject({ ok: true, status: "awaiting_cash" });
    const d = await detail(c.auditor, id);
    expect(d.decisions.map((x) => [x.capacity, x.officer, x.decision])).toEqual([
      ["compliance", c.compliance_officer.handle, "approve"],
      ["trustee", c.trustee_officer.handle, "approve"],
    ]);
    expect(d.payment?.code).toMatch(/^PT-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(d.payment?.escrowPaisa).toBe("0");
    expect(d.commands.propose).toBeNull();
    // The cash leg waits for execution.
    expect((await detail(c.ops_maker, id)).blockers.prepare.join(" ")).toMatch(/Settlement after execution/);
    expect((await detail(c.ops_checker, id)).blockers.confirm.join(" ")).toMatch(/Nothing is prepared/);
    await fresh(c.ops_maker);
    const early = await w.portal.query<{ r: R }>("SELECT admin.transfer_cash($1, $2, 'prepare_settlement', NULL, $3) AS r", [c.ops_maker.sessionHash, id, Buffer.from(d.digest, "hex")]);
    expect(early.rows[0]?.r.error).toMatch(/only after the movement/);
    expect(await code(w.portal.query("SELECT admin.transfer_cash($1, $2, 'prepare_settlement', NULL, $3)", [c.compliance_officer.sessionHash, id, Buffer.from(d.digest, "hex")]))).toBe("42501");
  });

  it("a compliance or trustee officer cancels before payment (T9); the dispute is for executed cases only", async () => {
    expect((await detail(c.compliance_officer, id)).blockers.dispute.join(" ")).toMatch(/executed or settled/);
    expect((await act(c.compliance_officer, id, "dispute")).error).toMatch(/executed or settled/);
    expect(await act(c.trustee_officer, id, "cancel", null, "buyer withdrew in writing before paying")).toMatchObject({ ok: true, status: "cancelled" });
    const row = await w.su.query<{ cancelled_by: string }>("SELECT cancelled_by FROM transfer.cases WHERE id = $1", [id]);
    expect(row.rows[0]?.cancelled_by).toBe(c.trustee_officer.handle);
    expect((await act(c.compliance_officer, id, "cancel")).error).toMatch(/cannot be cancelled/);
  });
});

describe("a gift: approved straight to the on-chain proposal", () => {
  it("compliance + trustee approve; the propose command is enqueued under the final approver's handle", async () => {
    const seller = await party(w.su, 500n);
    const buyer = await party(w.su);
    const r = await open(c.ops_maker, seller, buyer, 20, "gift", null);
    expect(r).toMatchObject({ ok: true });
    const id = r.id ?? 0;
    expect(await act(c.ops_maker, id, "complete")).toMatchObject({ ok: true, status: "checks" });
    expect(await act(c.trustee_officer, id, "approve", "trustee")).toMatchObject({ ok: true, status: "checks" });
    expect(await act(c.compliance_officer, id, "approve", "compliance")).toMatchObject({ ok: true, status: "proposed" });
    const d = await detail(c.ops_checker, id);
    expect(d.payment).toBeNull();
    expect(d.commands.propose).toMatchObject({ kind: "transfer.propose" });
    const cmd = await w.su.query<{ created_by: string; payload: { amount: string } }>("SELECT created_by, payload FROM outbox.commands WHERE idempotency_key = $1", [`transfer.propose:case:${String(id)}`]);
    expect(cmd.rows[0]).toMatchObject({ created_by: c.compliance_officer.handle, payload: { amount: "20" } });
    // No cash leg for a gift.
    expect((await detail(c.ops_maker, id)).blockers.prepare.join(" ")).toMatch(/No cash leg/);
  });
});

describe("rejection, conflicts and links", () => {
  it("one rejection ends the case", async () => {
    const seller = await party(w.su, 300n);
    const buyer = await party(w.su);
    const id = (await open(c.ops_maker, seller, buyer, 10)).id ?? 0;
    expect(await act(c.ops_maker, id, "complete")).toMatchObject({ ok: true, status: "checks" });
    expect(await act(c.compliance_officer, id, "reject", "compliance", "source of funds not explained")).toMatchObject({ ok: true, status: "rejected" });
    expect((await act(c.trustee_officer, id, "approve", "trustee")).error).toMatch(/the case is rejected/);
  });

  it("an officer who declared a conflict with a party cannot decide; any reader may declare one", async () => {
    const seller = await party(w.su, 300n);
    const buyer = await party(w.su);
    const id = (await open(c.ops_maker, seller, buyer, 10)).id ?? 0;
    expect(await act(c.ops_maker, id, "complete")).toMatchObject({ ok: true, status: "checks" });
    for (const a of [c.trustee_officer, c.auditor]) {
      await fresh(a);
      const r = await w.portal.query<{ r: R }>("SELECT admin.transfer_declare_conflict($1, $2, 'the investor is a relative of mine') AS r", [a.sessionHash, buyer.subjectId]);
      expect(r.rows[0]?.r).toMatchObject({ ok: true, status: "declared" });
    }
    await fresh(c.trustee_officer);
    const twice = await w.portal.query<{ r: R }>("SELECT admin.transfer_declare_conflict($1, $2, 'the investor is a relative of mine') AS r", [c.trustee_officer.sessionHash, buyer.subjectId]);
    expect(twice.rows[0]?.r.ok).toBe(false);
    expect((await detail(c.trustee_officer, id)).blockers.decide.join(" ")).toMatch(/declared a conflict/);
    expect((await act(c.trustee_officer, id, "approve", "trustee")).error).toMatch(/declared a conflict/);
    expect(await code(w.portal.query("SELECT admin.transfer_declare_conflict($1, $2, 'the investor is a relative of mine')", [c.legal_officer.sessionHash, buyer.subjectId]))).toBe("42501");
  });

  it("links are recorded by compliance officers only; a sale between linked investors raises an alert that only compliance and auditors see", async () => {
    const seller = await party(w.su, 300n);
    const buyer = await party(w.su);
    await fresh(c.trustee_officer);
    const byTrustee = await w.portal.query<{ r: R }>("SELECT admin.transfer_link_parties($1, $2, $3, 'family', 'brothers according to the KYC file') AS r", [c.trustee_officer.sessionHash, seller.subjectId, buyer.subjectId]);
    expect(byTrustee.rows[0]?.r).toMatchObject({ ok: false, error: expect.stringMatching(/compliance_officer/) as unknown });
    expect(await code(w.portal.query("SELECT admin.transfer_link_parties($1, $2, $3, 'family', 'brothers according to the KYC file')", [c.ops_maker.sessionHash, seller.subjectId, buyer.subjectId]))).toBe("42501");
    await fresh(c.compliance_officer);
    const link = await w.portal.query<{ r: R }>("SELECT admin.transfer_link_parties($1, $2, $3, 'family', 'brothers according to the KYC file') AS r", [c.compliance_officer.sessionHash, seller.subjectId, buyer.subjectId]);
    expect(link.rows[0]?.r).toMatchObject({ ok: true });
    const id = (await open(c.ops_maker, seller, buyer, 10)).id ?? 0;
    expect(await act(c.ops_maker, id, "complete")).toMatchObject({ ok: true, status: "checks" });
    for (const a of [c.compliance_officer, c.auditor]) {
      const d = await detail(a, id);
      expect(d.alerts?.map((x) => x.rule)).toContain("linked_parties");
    }
    for (const a of [c.ops_maker, c.ops_checker, c.trustee_officer]) {
      expect((await detail(a, id)).alerts).toBeNull();
    }
  });
});

describe("reference prices, the queue and the trail", () => {
  it("operations checkers record reference prices; the list shows them with the counts", async () => {
    await fresh(c.ops_checker);
    const evidence = randomBytes(32).toString("hex");
    const r = await w.portal.query<{ r: R }>("SELECT admin.transfer_set_price($1, $2, 110000, $3, 'valuation by the panel valuer, October') AS r", [c.ops_checker.sessionHash, TRANSFER_TOKEN, evidence]);
    expect(r.rows[0]?.r).toMatchObject({ ok: true, status: "recorded" });
    await fresh(c.ops_maker);
    expect(await code(w.portal.query("SELECT admin.transfer_set_price($1, $2, 110000, $3, 'valuation by the panel valuer, October')", [c.ops_maker.sessionHash, TRANSFER_TOKEN, evidence]))).toBe("42501");
    const l = (await w.portal.query<{ v: { token: string; referencePrice: { pricePaisa: string; source: string }; counts: Record<string, number>; cases: { id: number }[]; policies: Record<string, boolean>; prices: { by: string }[] } }>(
      "SELECT admin.transfer_cases($1, NULL) AS v",
      [c.auditor.sessionHash],
    )).rows[0]?.v;
    expect(l?.token).toBe(TRANSFER_TOKEN);
    expect(l?.referencePrice).toMatchObject({ pricePaisa: "110000", source: expect.stringMatching(/^valuation/) as unknown });
    expect(l?.policies).toEqual({ propose: true, execute: true, cancel: true });
    expect(l?.counts).toMatchObject({ cancelled: 1, proposed: 1, rejected: 1, checks: 2 });
    expect(l?.prices[0]?.by).toBe(c.ops_checker.handle);
    const only = (await w.portal.query<{ v: { cases: unknown[] } }>("SELECT admin.transfer_cases($1, 'rejected') AS v", [c.trustee_officer.sessionHash])).rows[0]?.v;
    expect(only?.cases).toHaveLength(1);
    expect(JSON.stringify(l)).not.toMatch(/cnic|iban/i);
  });

  it("refresh from chain is for the desk; reads for every transfer role and nobody else", async () => {
    await fresh(c.ops_maker);
    expect((await w.portal.query<{ r: R }>("SELECT admin.transfer_sync($1) AS r", [c.ops_maker.sessionHash])).rows[0]?.r.ok).toBe(true);
    expect(await code(w.portal.query("SELECT admin.transfer_sync($1)", [c.compliance_officer.sessionHash]))).toBe("42501");
    for (const a of [c.legal_officer, c.tax_officer, c.admin]) {
      expect(await code(w.portal.query("SELECT admin.transfer_cases($1, NULL)", [a.sessionHash]))).toBe("42501");
      expect(await code(w.portal.query("SELECT admin.transfer_case($1, 1)", [a.sessionHash]))).toBe("42501");
    }
  });

  it("the transfer and admin audit chains verify; the transfer chain is readable in PT Control", async () => {
    expect((await w.su.query("SELECT * FROM transfer.verify_audit()")).rows).toEqual([]);
    expect((await w.su.query("SELECT * FROM admin.verify_audit()")).rows).toEqual([]);
    const a = (await w.portal.query<{ v: { problems: number; rows: { action: string }[] } }>("SELECT admin.transfer_audit($1, NULL, 500) AS v", [c.auditor.sessionHash])).rows[0]?.v;
    expect(a?.problems).toBe(0);
    expect(a?.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["case.opened", "case.checks", "case.decided", "case.approved", "case.awaiting_cash", "case.cancelled", "price.recorded", "conflict.declared", "link.recorded", "alert.raised"]));
    const actions = (await w.su.query<{ action: string }>("SELECT DISTINCT action FROM admin.audit")).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["transfer.requested", "transfer.decided", "transfer.price", "transfer.conflict", "transfer.link", "transfer.synced", "approval.refused"]));
  });
});
