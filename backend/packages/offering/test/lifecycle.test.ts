import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OfferingError, executeApprovedRefunds } from "../src/service.ts";
import {
  accept,
  ageClose,
  ageDeadline,
  ageReservation,
  investor,
  liveOffering,
  mintOnChain,
  money,
  OF,
  offeringState,
  passRecon,
  pay,
  reserve,
  submittedOffering,
  subState,
  units,
  hex32,
  type Investor,
  type Offering,
  type World,
  makeWorld,
} from "./world.ts";

/** S-02 end to end against PostgreSQL: the offering and investment state machines, money and mints. */

let w: World;
beforeAll(async () => {
  w = await makeWorld();
}, 120_000);
afterAll(async () => {
  await w.drop();
}, 120_000);

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof OfferingError) return e.code;
    throw e;
  }
  return "OK";
};

async function paidInvestor(o: Offering, unitsWanted: bigint): Promise<{ inv: Investor; sub: string }> {
  const inv = await investor(w, o.d);
  await accept(w, o.id, inv, o.docs);
  const r = await reserve(w, o.id, inv, unitsWanted);
  expect(r.state).toBe("payment_pending");
  await pay(w, inv, r.paymentCode, BigInt(r.amountPaisa));
  return { inv, sub: r.subscriptionId };
}

/** Close, trustee confirms L11 (funded). */
async function fund(o: Offering): Promise<void> {
  await ageClose(w, o.id);
  const t = await w.of("tick", { offeringId: o.id, actor: OF.system });
  expect(t.state).toBe("closing");
  const req = String(t.proposed);
  expect(await w.of("decide", { requestId: req, officer: OF.trustee, approve: true, reason: "paid units confirmed with the bank" })).toBe("approved");
  expect(await offeringState(w, o.id)).toBe("funded");
}

const CONDITIONS = (): Record<string, string> =>
  Object.fromEntries(["encumbrances_discharged", "sale_deed_ready", "approvals_consents", "insurance", "trust_deed_executed", "register_ready"].map((k) => [k, hex32()]));

/** IB + L13 + CMP + start minting. */
async function toMinting(o: Offering): Promise<number> {
  await w.of("prepareBatch", { offeringId: o.id, actor: OF.maker, reason: "issuance batch from the allocations" });
  expect(await w.of("decideAll", { offeringId: o.id, code: "IB", officer: OF.checker, approve: true, reason: "batch checked against allocations" })).toBe(1);
  expect(await w.of("decideAll", { offeringId: o.id, code: "IB", officer: OF.trustee, approve: true, reason: "batch checked against the register" })).toBe(1);
  const l13 = await w.of("request", { offeringId: o.id, code: "L13", actor: OF.maker, reason: "all conditions precedent evidenced", detail: { conditions: CONDITIONS() } });
  await w.of("decide", { requestId: l13, officer: OF.checker2, approve: true, reason: "conditions evidence reviewed" });
  expect(await w.of("decide", { requestId: l13, officer: OF.trustee, approve: true, reason: "trustee agrees to complete" })).toBe("approved");
  expect(await offeringState(w, o.id)).toBe("completing");
  const cmp = await w.of("request", {
    offeringId: o.id,
    code: "CMP",
    actor: OF.maker,
    reason: "sale deed registered, seller paid",
    detail: { deedSha: hex32(), deedRegistration: "Sub-Registrar Cantt 1234/2026", batchReference: "PTCMP-0001", batchFileSha: hex32() },
  });
  await w.of("decide", { requestId: cmp, officer: OF.trustee, approve: true, reason: "deed and payments verified" });
  return w.of("startMinting", { offeringId: o.id, actor: OF.system });
}

describe("offering approval (L1-L5) and maker-checker", () => {
  it("needs the checker, legal head, compliance and trustee, never the maker; terms freeze at submission", async () => {
    const o = await submittedOffering(w);
    expect(await code(w.of("decide", { requestId: o.l3, officer: OF.maker, approve: true, reason: "self approval attempt" }))).toBe("FORBIDDEN");
    expect(await code(w.of("decide", { requestId: o.l3, officer: OF.bank1, approve: true, reason: "wrong duty approves" }))).toBe("FORBIDDEN");
    expect(await code(w.of("updateTerms", { offeringId: o.id, actor: OF.maker, terms: { minUnits: 20n } }))).toBe("GUARD");
    // Even the administrator cannot change terms directly once submitted.
    await expect(w.client.query("UPDATE offering.offerings SET price_paisa = 1 WHERE id = $1", [o.id])).rejects.toThrow(/immutable once submitted/);
    await expect(w.client.query("UPDATE offering.offerings SET state = 'live' WHERE id = $1", [o.id])).rejects.toThrow(/event log/);
    expect(await w.of("decide", { requestId: o.l3, officer: OF.checker, approve: true, reason: "terms checked" })).toBe("open");
    expect(await code(w.of("decide", { requestId: o.l3, officer: OF.checker2, approve: true, reason: "second checker, same duty" }))).toBe("FORBIDDEN");
    expect(await w.of("decide", { requestId: o.l3, officer: OF.legalHead, approve: true, reason: "documents approved" })).toBe("open");
    expect(await w.of("decide", { requestId: o.l3, officer: OF.compliance, approve: true, reason: "eligibility approved" })).toBe("open");
    expect(await w.of("decide", { requestId: o.l3, officer: OF.trustee, approve: true, reason: "trustee approves" })).toBe("approved");
    expect(await offeringState(w, o.id)).toBe("approved");
    // L4 checks the read model: unknown token, unpaused token, cap too low, documents not anchored.
    expect(await code(w.of("markReady", { offeringId: o.id, token: `0x${"ab".repeat(20)}`, actor: OF.maker }))).toBe("GUARD");
    const { deployToken } = await import("./world.ts");
    const low = await deployToken(w, { cap: o.cap - 1n, docs: [o.docs.en, o.docs.ur] });
    expect(await code(w.of("markReady", { offeringId: o.id, token: low.token, actor: OF.maker }))).toBe("GUARD");
    const nodocs = await deployToken(w, { cap: o.cap, docs: [o.docs.en] });
    expect(await code(w.of("markReady", { offeringId: o.id, token: nodocs.token, actor: OF.maker }))).toBe("GUARD");
    const good = await deployToken(w, { cap: o.cap, docs: [o.docs.en, o.docs.ur] });
    expect(await w.of("markReady", { offeringId: o.id, token: good.token, actor: OF.maker })).toBe("ready");
    expect((await w.of("tick", { offeringId: o.id, actor: OF.system })).state).toBe("live");
  }, 120_000);

  it("refuses incomplete or inconsistent terms and a second offering for the same property", async () => {
    const o = await submittedOffering(w);
    expect(await code(w.of("createOffering", { propertyId: o.propertyId, actor: OF.maker }))).toBe("DUPLICATE");
    // A rejection is final; the maker returns to draft only through L2 by another officer.
    expect(await w.of("decide", { requestId: o.l3, officer: OF.legalHead, approve: false, reason: "risk disclosure misses the title risk" })).toBe("rejected");
    expect(await code(w.of("decide", { requestId: o.l3, officer: OF.checker, approve: true, reason: "too late to approve" }))).toBe("GUARD");
    expect(await code(w.of("returnOffering", { offeringId: o.id, actor: OF.maker, reason: "maker returns own file" }))).toBe("FORBIDDEN");
    expect(await w.of("returnOffering", { offeringId: o.id, actor: OF.legalHead, reason: "update the risk disclosure" })).toBe("draft");
    expect(await code(w.of("updateTerms", { offeringId: o.id, actor: OF.maker, terms: { minRaiseUnits: 10n } }))).toBe("OK");
    expect(await code(w.of("submit", { offeringId: o.id, actor: OF.maker, reason: "resubmitted after the fix" }))).toBe("GUARD"); // all-or-nothing
    expect(await code(w.of("updateTerms", { offeringId: o.id, actor: OF.maker, terms: { minRaiseUnits: o.cap, useOfProceeds: [{ line: "purchase_price", paisa: 1n }] } }))).toBe("OK");
    expect(await code(w.of("submit", { offeringId: o.id, actor: OF.maker, reason: "resubmitted after the fix" }))).toBe("GUARD"); // OF-3 sum
  }, 120_000);
});

describe("reservations, FCFS and the waitlist (OF-15..OF-19)", () => {
  let o: Offering;
  beforeAll(async () => {
    o = await liveOffering(w, { cap: 100n, maxUnits: 50n });
  }, 120_000);

  it("reserves with a payment code, is idempotent, refuses a second open reservation and units outside the bounds", async () => {
    const a = await investor(w, o.d);
    expect(await code(reserve(w, o.id, a, 10n))).toBe("GUARD"); // documents not accepted (OF-10)
    await accept(w, o.id, a, o.docs);
    expect(await code(reserve(w, o.id, a, 5n))).toBe("INVALID_INPUT"); // below min
    expect(await code(reserve(w, o.id, a, 51n))).toBe("INVALID_INPUT"); // above max
    const r1 = await reserve(w, o.id, a, 40n, "idem-a-0001");
    expect(r1).toMatchObject({ state: "payment_pending", units: "40", amountPaisa: String(40n * o.price) });
    expect(r1.paymentCode).toMatch(/^PT-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    const again = await reserve(w, o.id, a, 40n, "idem-a-0001");
    expect(again.subscriptionId).toBe(r1.subscriptionId);
    expect(await code(reserve(w, o.id, a, 41n, "idem-a-0001"))).toBe("DUPLICATE");
    expect(await code(reserve(w, o.id, a, 10n, "idem-a-0002"))).toBe("DUPLICATE"); // OF-17
    expect(await units(w, o.id)).toMatchObject({ held: 40n, reserved: 40n, paid: 0n });
  });

  it("rejects ineligible investors (no registry entry, no bank account) without tipping off", async () => {
    const noReg = await investor(w, o.d, { registered: false });
    await accept(w, o.id, noReg, o.docs);
    const r = await reserve(w, o.id, noReg, 10n);
    expect(r.state).toBe("rejected");
    expect(r.reason).toMatch(/not registered/);
    const noBank = await investor(w, o.d, { payee: false });
    await accept(w, o.id, noBank, o.docs);
    expect((await reserve(w, o.id, noBank, 10n)).state).toBe("rejected");
  });

  it("waitlists when no units are free and promotes the oldest when a reservation expires or is cancelled", async () => {
    const b = await investor(w, o.d);
    await accept(w, o.id, b, o.docs);
    const rb = await reserve(w, o.id, b, 50n);
    expect(rb.state).toBe("payment_pending");
    expect((await units(w, o.id)).held).toBe(90n);
    const c = await investor(w, o.d);
    await accept(w, o.id, c, o.docs);
    const rc = await reserve(w, o.id, c, 20n);
    expect(rc.state).toBe("waitlisted");
    const d = await investor(w, o.d);
    await accept(w, o.id, d, o.docs);
    const rd = await reserve(w, o.id, d, 10n);
    // Strict FIFO: 10 units are free, but the queue is not jumped.
    expect(rd.state).toBe("waitlisted");
    // b's reservation expires: c (oldest) gets 20 units, then d gets 10? 100 - 40 - 20 = 40 free: d too.
    await ageReservation(w, rb.subscriptionId);
    const t = await w.of("tick", { offeringId: o.id, actor: OF.system });
    expect(t).toMatchObject({ expired: 1, promoted: 2, state: "live" });
    expect(await subState(w, rb.subscriptionId)).toBe("expired");
    expect(await subState(w, rc.subscriptionId)).toBe("payment_pending");
    expect(await subState(w, rd.subscriptionId)).toBe("payment_pending");
    // A late payment with the expired code goes to suspense, never to the investor.
    const late = await pay(w, b, rb.paymentCode, BigInt(rb.amountPaisa));
    const { rows } = await w.client.query<{ status: string; reason: string }>("SELECT status, reason FROM bank.credits WHERE raast_ref = $1", [late]);
    expect(rows[0]).toMatchObject({ status: "suspense", reason: "payment code expired" });
    expect(await subState(w, rb.subscriptionId)).toBe("expired");
    // d cancels; the code is cancelled with it, so paying it now lands in suspense.
    const sd = await w.of("cancel", { subscriptionId: rd.subscriptionId, subjectId: d.subjectId, actor: `investor:${d.subjectId}` });
    expect(sd.state).toBe("cancelled");
    const promoted = await w.of("syncPayment", { subscriptionId: rd.subscriptionId, actor: OF.system });
    expect(promoted.paymentCode).toMatch(/^PT-/);
    const after = await pay(w, d, promoted.paymentCode, BigInt(rd.amountPaisa));
    const { rows: r2 } = await w.client.query<{ status: string; reason: string }>("SELECT status, reason FROM bank.credits WHERE raast_ref = $1", [after]);
    expect(r2[0]).toMatchObject({ status: "suspense", reason: "payment code cancelled" });
  });

  it("matches only exact payments from the investor's registered account (wrong amount, third party -> suspense)", async () => {
    const e = await investor(w, o.d);
    await accept(w, o.id, e, o.docs);
    const r = await reserve(w, o.id, e, 10n);
    expect(r.state).toBe("payment_pending");
    const wrong = await pay(w, e, r.paymentCode, BigInt(r.amountPaisa) - 1n);
    const stranger = await investor(w, o.d);
    const third = await pay(w, e, r.paymentCode, BigInt(r.amountPaisa), stranger.iban);
    const { rows } = await w.client.query<{ raast_ref: string; status: string; reason: string }>(
      "SELECT raast_ref, status, reason FROM bank.credits WHERE raast_ref = ANY($1) ORDER BY reason",
      [[wrong, third]],
    );
    expect(rows.map((x) => x.reason).sort()).toEqual(["amount differs from the payment code", "paid from an account not registered to the investor"]);
    expect(rows.every((x) => x.status === "suspense")).toBe(true);
    expect(await subState(w, r.subscriptionId)).toBe("payment_pending");
    await pay(w, e, r.paymentCode, BigInt(r.amountPaisa));
    expect(await subState(w, r.subscriptionId)).toBe("payment_confirmed");
    // A paid subscription cannot be cancelled; paying the same code twice goes to suspense.
    expect(await code(w.of("cancel", { subscriptionId: r.subscriptionId, subjectId: e.subjectId, actor: `investor:${e.subjectId}` }))).toBe("GUARD");
    const twice = await pay(w, e, r.paymentCode, BigInt(r.amountPaisa));
    const { rows: t } = await w.client.query<{ status: string }>("SELECT status FROM bank.credits WHERE raast_ref = $1", [twice]);
    expect(t[0]?.status).toBe("suspense");
  });
});

describe("compliance and audit", () => {
  it("blocks a sanctioned paid subscription (funds stay), hides the reason from the investor, and the audit chain verifies", async () => {
    const o = await liveOffering(w, { cap: 100n, maxUnits: 50n });
    const a = await paidInvestor(o, 20n);
    expect(await code(w.of("block", { subscriptionId: a.sub, officer: OF.maker, reason: "sanctions list hit on payer" }))).toBe("FORBIDDEN");
    expect(await w.of("block", { subscriptionId: a.sub, officer: OF.compliance, reason: "sanctions list hit on payer" })).toBe("blocked");
    const { rows } = await w.client.query<{ public_reason: string }>("SELECT public_reason FROM offering.investor_subscriptions WHERE subscription_id = $1", [a.sub]);
    expect(rows[0]?.public_reason).toBe("under review");
    // A blocked investor cannot subscribe elsewhere (OF-13).
    const o2 = await liveOffering(w, { cap: 100n, maxUnits: 50n });
    await w.client.query("INSERT INTO chain.investors (registry, wallet, identity, country, registered, updated_block) VALUES ($1, $2, $3, 586, true, 0)", [o2.d.identityRegistry, a.inv.wallet, `0x${"1".repeat(40)}`]);
    await accept(w, o2.id, a.inv, o2.docs);
    const r = await reserve(w, o2.id, a.inv, 10n);
    expect(r).toMatchObject({ state: "rejected", reason: "not eligible for this offering" });
    // Nothing was written around the API so far: the chain and every replayed state verify.
    expect((await w.client.query("SELECT * FROM offering.verify_audit()")).rows).toEqual([]);
    expect((await w.client.query("SELECT * FROM bank.verify_audit()")).rows).toEqual([]);
  }, 180_000);
});

describe("closing outcomes", () => {
  it("funded -> completion -> mint exactly once per paid subscription -> settled -> completed", async () => {
    const o = await liveOffering(w, { cap: 100n, maxUnits: 60n });
    const a = await paidInvestor(o, 60n);
    const b = await paidInvestor(o, 40n);
    expect(await units(w, o.id)).toMatchObject({ paid: 100n, held: 100n });
    // No mint command exists before completion.
    const mints = async (): Promise<number> =>
      Number((await w.client.query<{ n: string }>("SELECT count(*) AS n FROM outbox.commands WHERE kind = 'issuance.mint' AND ref = $1", [`offering:${o.id}`])).rows[0]?.n);
    await fund(o);
    expect(await subState(w, a.sub)).toBe("allocation_pending");
    expect(await mints()).toBe(0);
    expect(await code(w.of("startMinting", { offeringId: o.id, actor: OF.system }))).toBe("GUARD");
    // OF-SOD-2: the batch preparer cannot approve the completion (L13).
    await w.of("prepareBatch", { offeringId: o.id, actor: OF.maker, reason: "issuance batch from the allocations" });
    expect(await code(w.of("decideAll", { offeringId: o.id, code: "IB", officer: OF.maker, approve: true, reason: "preparer approves own batch" }))).toBe("FORBIDDEN");
    expect(await toMinting(o)).toBe(2);
    expect(await mints()).toBe(2);
    // Idempotent: a second call (crash and retry of the job) enqueues nothing new.
    expect(await w.of("startMinting", { offeringId: o.id, actor: OF.system })).toBe(0);
    expect(await mints()).toBe(2);
    const { rows: cmds } = await w.client.query<{ idempotency_key: string; payload: { to: string; amount: string; refId: string } }>(
      "SELECT idempotency_key, payload FROM outbox.commands WHERE ref = $1 ORDER BY id",
      [`offering:${o.id}`],
    );
    const refA = (await w.client.query<{ ref_id: string }>("SELECT ref_id FROM offering.subscriptions WHERE id = $1", [a.sub])).rows[0]?.ref_id ?? "";
    expect(cmds.find((c) => c.payload.refId === refA)).toMatchObject({ idempotency_key: `mint:${refA}`, payload: { to: a.inv.wallet, amount: "60" } });
    // The signer's fact: allowed for the batch item, refused for anything else.
    const allowed = async (ref: string, to: string, amount: bigint): Promise<string | null> =>
      (await w.client.query<{ r: string | null }>("SELECT offering.mint_allowed($1, $2, $3) AS r", [ref, to, amount.toString()])).rows[0]?.r ?? null;
    expect(await allowed(refA, a.inv.wallet, 60n)).toBeNull();
    expect(await allowed(refA, a.inv.wallet, 61n)).toMatch(/approved issuance batch/);
    expect(await allowed(refA, b.inv.wallet, 60n)).toMatch(/approved issuance batch/);
    expect(await allowed(`0x${"0".repeat(64)}`, a.inv.wallet, 60n)).toMatch(/not an offering subscription/);
    // The chain mints; settlement follows the read model.
    await mintOnChain(w, o.d, refA, a.inv.wallet, 60n);
    expect(await w.of("settle", { offeringId: o.id, actor: OF.system })).toEqual({ settled: 1, review: 0 });
    expect(await subState(w, a.sub)).toBe("tokens_issued");
    expect(await w.of("settle", { offeringId: o.id, actor: OF.system })).toEqual({ settled: 0, review: 0 });
    // L14 waits for every allocation.
    expect(await code(w.of("request", { offeringId: o.id, code: "L14", actor: OF.maker, reason: "register attested by the trustee", detail: { registerSha: hex32(), totalUnits: "100" } }))).toBe("GUARD");
    const refB = (await w.client.query<{ ref_id: string }>("SELECT ref_id FROM offering.subscriptions WHERE id = $1", [b.sub])).rows[0]?.ref_id ?? "";
    await mintOnChain(w, o.d, refB, b.inv.wallet, 40n);
    expect(await w.of("settle", { offeringId: o.id, actor: OF.system })).toEqual({ settled: 1, review: 0 });
    expect(await code(w.of("request", { offeringId: o.id, code: "L14", actor: OF.maker, reason: "register attested by the trustee", detail: { registerSha: hex32(), totalUnits: "99" } }))).toBe("GUARD");
    const l14 = await w.of("request", { offeringId: o.id, code: "L14", actor: OF.maker, reason: "register attested by the trustee", detail: { registerSha: hex32(), totalUnits: "100" } });
    expect(await w.of("decide", { requestId: l14, officer: OF.trustee, approve: true, reason: "register entries confirmed" })).toBe("approved");
    expect(await offeringState(w, o.id)).toBe("completed");
    expect(await subState(w, a.sub)).toBe("active");
    // Money: paid = settled, nothing held.
    const m = await money(w, o.id);
    expect(m).toEqual({ paid: 100n * o.price, refunded: 0n, settled: 100n * o.price, held: 0n });
  }, 180_000);

  it("under the min raise: all-or-nothing cancel with full refunds to the sender, two bank operators and the gate", async () => {
    const o = await liveOffering(w, { cap: 100n, maxUnits: 50n });
    const a = await paidInvestor(o, 30n);
    await paidInvestor(o, 20n);
    await ageClose(w, o.id);
    const t = await w.of("tick", { offeringId: o.id, actor: OF.system });
    expect(t.state).toBe("closing");
    await w.of("decide", { requestId: String(t.proposed), officer: OF.trustee, approve: true, reason: "min raise not met, confirmed" });
    expect(await offeringState(w, o.id)).toBe("refunding");
    expect(await subState(w, a.sub)).toBe("refund_pending");
    // Not approved yet: nothing can be sent.
    expect(await executeApprovedRefunds(w.pool, w.mock, o.id, OF.system)).toEqual([]);
    expect(await code(w.of("decideAll", { offeringId: o.id, code: "V20", officer: OF.maker, approve: true, reason: "wrong duty approves refunds" }))).toBe("FORBIDDEN");
    expect(await w.of("decideAll", { offeringId: o.id, code: "V20", officer: OF.bank1, approve: true, reason: "refund list checked against the ledger" })).toBe(2);
    expect(await w.of("decideAll", { offeringId: o.id, code: "V20", officer: OF.bank2, approve: true, reason: "second operator checked the list" })).toBe(2);
    // The reconciliation gate must be open.
    await expect(executeApprovedRefunds(w.pool, w.mock, o.id, OF.system)).rejects.toThrow(/blocked by reconciliation|payouts/);
    await passRecon(w);
    const before = w.mock.balancePaisa;
    const sent = await executeApprovedRefunds(w.pool, w.mock, o.id, OF.system);
    expect(sent).toHaveLength(2);
    expect(w.mock.balancePaisa).toBe(before - 50n * o.price);
    expect(await subState(w, a.sub)).toBe("refunded");
    expect(await offeringState(w, o.id)).toBe("cancelled");
    expect(await money(w, o.id)).toEqual({ paid: 50n * o.price, refunded: 50n * o.price, settled: 0n, held: 0n });
    // The refund journal carries the original Raast reference (the bank statement matches it).
    const { rows } = await w.client.query<{ ref: string; own: string }>(
      `SELECT j.external_ref AS ref, s.raast_ref AS own FROM offering.subscriptions s JOIN ledger.journal j ON j.id = s.refund_journal WHERE s.id = $1`,
      [a.sub],
    );
    expect(rows[0]?.ref).toBe(rows[0]?.own);
    // A cancelled offering frees the property for a new offering.
    expect(await code(w.of("createOffering", { propertyId: o.propertyId, actor: OF.maker, previousId: o.id }))).toBe("OK");
  }, 180_000);

  it("extension with a withdrawal right: a paid investor withdraws and is refunded; the offering continues", async () => {
    const o = await liveOffering(w, { cap: 100n, maxUnits: 50n });
    const a = await paidInvestor(o, 50n);
    expect(await code(w.of("withdraw", { subscriptionId: a.sub, subjectId: a.inv.subjectId, actor: `investor:${a.inv.subjectId}` }))).toBe("GUARD");
    const ext = await w.of("request", { offeringId: o.id, code: "L10", actor: OF.maker, reason: "slow uptake, extend by 20 days", detail: { days: 20, disclosureSha: hex32() } });
    expect(await code(w.of("request", { offeringId: o.id, code: "L10", actor: OF.maker, reason: "second extension attempt", detail: { days: 5, disclosureSha: hex32() } }))).toBe("DUPLICATE");
    await w.of("decide", { requestId: ext, officer: OF.checker, approve: true, reason: "extension reason accepted" });
    expect(await w.of("decide", { requestId: ext, officer: OF.trustee, approve: true, reason: "trustee agrees to extend" })).toBe("approved");
    // One extension only.
    expect(await code(w.of("request", { offeringId: o.id, code: "L10", actor: OF.maker, reason: "another extension attempt", detail: { days: 5, disclosureSha: hex32() } }))).toBe("GUARD");
    // The website shows the disclosure that opened the window (0036 WW-2) and withdraws through its wrapper (WW-1).
    const sha = (await w.client.query<{ s: string }>("SELECT detail->>'disclosureSha' AS s FROM offering.requests WHERE id = $1", [ext])).rows[0]?.s;
    const shown = await w.client.query<{ kind: string; sha256: string }>("SELECT kind, sha256 FROM offering.web_disclosures($1)", [o.id]);
    expect(shown.rows).toEqual([{ kind: "extension", sha256: sha }]);
    await expect(w.client.query("SELECT offering.web_withdraw($1, $2, $3)", [a.sub, a.inv.subjectId, `investor:${a.inv.subjectId}`])).rejects.toThrow(/web:<investor id>/);
    const v = (await w.client.query<{ r: { state: string } }>("SELECT offering.web_withdraw($1, $2, $3) AS r", [a.sub, a.inv.subjectId, `web:${randomUUID()}`])).rows[0]?.r ?? { state: "" };
    expect(v.state).toBe("refund_pending");
    await w.of("decideAll", { offeringId: o.id, code: "V20", officer: OF.bank1, approve: true, reason: "withdrawal refund checked" });
    await w.of("decideAll", { offeringId: o.id, code: "V20", officer: OF.bank3, approve: true, reason: "withdrawal refund checked" });
    await passRecon(w);
    expect(await executeApprovedRefunds(w.pool, w.mock, o.id, OF.system)).toHaveLength(1);
    expect(await subState(w, a.sub)).toBe("refunded");
    expect(await offeringState(w, o.id)).toBe("live");
    expect((await units(w, o.id)).held).toBe(0n);
    // A new investor can now take the freed units.
    const b = await paidInvestor(o, 50n);
    expect(await subState(w, b.sub)).toBe("payment_confirmed");
  }, 180_000);

  it("completion deadline missed (L15) and completion aborted (L16) refund allocations; no refund once minting started (OF-51)", async () => {
    const o = await liveOffering(w, { cap: 100n, maxUnits: 100n });
    const a = await paidInvestor(o, 100n);
    await fund(o);
    await ageDeadline(w, o.id);
    const t = await w.of("tick", { offeringId: o.id, actor: OF.system });
    await w.of("decide", { requestId: String(t.proposed), officer: OF.trustee, approve: true, reason: "deadline passed, confirm failure" });
    expect(await offeringState(w, o.id)).toBe("refunding");
    expect(await subState(w, a.sub)).toBe("refund_pending");

    const o2 = await liveOffering(w, { cap: 100n, maxUnits: 100n });
    const b = await paidInvestor(o2, 100n);
    await fund(o2);
    await toMinting(o2);
    expect(await code(w.of("request", { offeringId: o2.id, code: "L16", actor: OF.trustee, reason: "seller withdrew from the sale" }))).toBe("GUARD");
    expect(await code(w.of("refundSubscription", { subscriptionId: b.sub, officer: OF.compliance, reason: "attempted refund during minting" }))).toBe("GUARD");
    // Even an operator-forced refund cannot pass the database while the mint command lives.
    await w.client.query("ALTER TABLE offering.subscriptions DISABLE TRIGGER USER");
    await w.client.query("INSERT INTO offering.subscription_events (subscription_id, code, from_state, to_state, actor) VALUES ($1, 'V15', 'allocation_pending', 'refund_pending', 'dba')", [b.sub]);
    await w.client.query("UPDATE offering.subscriptions SET state = 'refund_pending' WHERE id = $1", [b.sub]);
    await w.client.query("ALTER TABLE offering.subscriptions ENABLE TRIGGER USER");
    await w.client.query("SELECT offering.open_refund($1, 'allocation_failed', 'dba', 'forced refund attempt by a DBA')", [b.sub]);
    await w.of("decideAll", { offeringId: o2.id, code: "V20", officer: OF.bank1, approve: true, reason: "approving a forced refund" });
    await w.of("decideAll", { offeringId: o2.id, code: "V20", officer: OF.bank2, approve: true, reason: "approving a forced refund" });
    await passRecon(w);
    await expect(executeApprovedRefunds(w.pool, w.mock, o2.id, OF.system)).rejects.toThrow(/could still be mined/);
    // The DBA's event and state change are found by the audit verification.
    const verify = await w.client.query<{ problem: string }>("SELECT * FROM offering.verify_audit()");
    expect(verify.rows.map((r) => r.problem)).toEqual(expect.arrayContaining([expect.stringMatching(/subscription event/)]));
  }, 240_000);

  it("a mint that fails goes to Issuance Review; a retry (V17) is maker-checker and uses the same refId", async () => {
    const o = await liveOffering(w, { cap: 50n, maxUnits: 50n });
    const a = await paidInvestor(o, 50n);
    await fund(o);
    await toMinting(o);
    await w.client.query("UPDATE outbox.commands SET status = 'claimed', lease_owner = 'w', lease_until = now() + interval '1 minute' WHERE ref = $1", [`offering:${o.id}`]);
    await w.client.query("UPDATE outbox.commands SET status = 'failed', last_error = 'recipient not verified' WHERE ref = $1", [`offering:${o.id}`]);
    expect(await w.of("settle", { offeringId: o.id, actor: OF.system })).toEqual({ settled: 0, review: 1 });
    expect(await subState(w, a.sub)).toBe("issuance_review");
    const v17 = await w.of("request", { offeringId: o.id, code: "V17", actor: OF.checker, reason: "investor re-registered on chain", subscriptionId: a.sub });
    expect(await code(w.of("decide", { requestId: v17, officer: OF.maker, approve: true, reason: "batch preparer approves retry" }))).toBe("FORBIDDEN");
    expect(await w.of("decide", { requestId: v17, officer: OF.checker2, approve: true, reason: "cause fixed, retry" })).toBe("approved");
    const { rows } = await w.client.query<{ idempotency_key: string; status: string }>("SELECT idempotency_key, status FROM outbox.commands WHERE ref = $1 ORDER BY id", [`offering:${o.id}`]);
    expect(rows.map((r) => r.status)).toEqual(["failed", "pending"]);
    expect(rows[1]?.idempotency_key).toMatch(/:retry:2$/);
    const ref = (await w.client.query<{ ref_id: string }>("SELECT ref_id FROM offering.subscriptions WHERE id = $1", [a.sub])).rows[0]?.ref_id ?? "";
    expect((await w.client.query<{ r: string | null }>("SELECT offering.mint_allowed($1, $2, 50) AS r", [ref, a.inv.wallet])).rows[0]?.r).toBeNull();
    await mintOnChain(w, o.d, ref, a.inv.wallet, 50n);
    expect(await w.of("settle", { offeringId: o.id, actor: OF.system })).toEqual({ settled: 1, review: 0 });
    expect(await subState(w, a.sub)).toBe("tokens_issued");
  }, 180_000);
});

