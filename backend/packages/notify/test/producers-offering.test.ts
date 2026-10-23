import { randomBytes, randomUUID } from "node:crypto";
import { makeIban } from "@pt/bank";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeApprovedRefunds } from "../../offering/src/service.ts";
import {
  accept,
  ageClose,
  ageReservation,
  hex32,
  investor,
  liveOffering,
  makeWorld,
  mintOnChain,
  OF,
  offeringState,
  passRecon,
  pay,
  reserve,
  subState,
  type Investor,
  type Offering,
  type World,
} from "../../offering/test/world.ts";
import { ContactSecrets } from "../src/crypto.ts";
import { NotifyService, sweep, verifyAudit } from "../src/service.ts";
import { contacts, kindsOf, notesOf, producerFailureCount } from "./helpers.ts";

/**
 * Migration 0030 producers of S-02 (offerings) and the bank, end to end on the offering test world:
 * every business change that should notify creates exactly one notification in the same
 * transaction; a retried call, a re-run job or a rolled-back change creates none; nothing is said
 * about blocked subscriptions (NP-4); officers hear about requests waiting for their duty.
 */

let w: World;
beforeAll(async () => {
  w = await makeWorld();
}, 180_000);
afterAll(async () => {
  await w.drop();
}, 120_000);

const count = async (subject: string, kind: string): Promise<number> => (await notesOf(w.pool, "investor", subject, kind)).length;

async function paidInvestor(o: Offering, units: bigint): Promise<{ inv: Investor; sub: string; code: string }> {
  const inv = await investor(w, o.d);
  await accept(w, o.id, inv, o.docs);
  const r = await reserve(w, o.id, inv, units);
  expect(r.state).toBe("payment_pending");
  await pay(w, inv, r.paymentCode, BigInt(r.amountPaisa));
  return { inv, sub: r.subscriptionId, code: r.paymentCode ?? "" };
}

async function fund(o: Offering): Promise<void> {
  await ageClose(w, o.id);
  const t = await w.of("tick", { offeringId: o.id, actor: OF.system });
  expect(t.state).toBe("closing");
  await w.of("decide", { requestId: String(t.proposed), officer: OF.trustee, approve: true, reason: "paid units confirmed with the bank" });
  expect(await offeringState(w, o.id)).toBe("funded");
}

const CONDITIONS = (): Record<string, string> =>
  Object.fromEntries(["encumbrances_discharged", "sale_deed_ready", "approvals_consents", "insurance", "trust_deed_executed", "register_ready"].map((k) => [k, hex32()]));

async function toMinting(o: Offering): Promise<number> {
  await w.of("prepareBatch", { offeringId: o.id, actor: OF.maker, reason: "issuance batch from the allocations" });
  await w.of("decideAll", { offeringId: o.id, code: "IB", officer: OF.checker, approve: true, reason: "batch checked against allocations" });
  await w.of("decideAll", { offeringId: o.id, code: "IB", officer: OF.trustee, approve: true, reason: "batch checked against the register" });
  const l13 = await w.of("request", { offeringId: o.id, code: "L13", actor: OF.maker, reason: "all conditions precedent evidenced", detail: { conditions: CONDITIONS() } });
  await w.of("decide", { requestId: l13, officer: OF.checker2, approve: true, reason: "conditions evidence reviewed" });
  await w.of("decide", { requestId: l13, officer: OF.trustee, approve: true, reason: "trustee agrees to complete" });
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

describe("offering and bank producers", () => {
  it("a full offering: reserved, paid, allocated, issued — exactly one notice each, none on retry; payout account added once", async () => {
    const o = await liveOffering(w, { cap: 100n, maxUnits: 60n });
    const inv = await investor(w, o.d);
    // investor() registered a payout account: one security notice with the cooling-off end.
    const payee = await notesOf(w.pool, "investor", inv.subjectId, "security.payout_account_added");
    expect(payee).toHaveLength(1);
    expect(payee[0]?.category).toBe("security");
    expect(payee[0]?.params.last4).toMatch(/^[0-9]{4}$/);
    // The KYC service verified the investor: one generic status notice.
    expect((await notesOf(w.pool, "investor", inv.subjectId, "security.kyc_status_changed")).map((n) => n.params.status)).toEqual(["verified"]);

    await accept(w, o.id, inv, o.docs);
    const r = await reserve(w, o.id, inv, 60n, "idem-full-offering-1");
    const again = await reserve(w, o.id, inv, 60n, "idem-full-offering-1");
    expect(again.subscriptionId).toBe(r.subscriptionId);
    const reserved = await notesOf(w.pool, "investor", inv.subjectId, "offering.reserved");
    expect(reserved).toHaveLength(1);
    expect(reserved[0]?.params).toMatchObject({ amount_paisa: String(60n * o.price) });
    expect(reserved[0]?.params.offering).toMatch(/^[A-Za-z]/);
    expect(reserved[0]?.key).toMatch(/^offering:sub-event:\d+$/);

    await pay(w, inv, r.paymentCode, BigInt(r.amountPaisa));
    expect(await count(inv.subjectId, "offering.payment_received")).toBe(1);
    const b = await paidInvestor(o, 40n);
    await fund(o);
    expect(await count(inv.subjectId, "offering.allocated")).toBe(1);
    expect((await notesOf(w.pool, "investor", inv.subjectId, "offering.allocated"))[0]?.params.units).toBe("60");
    expect(await toMinting(o)).toBe(2);
    const refA = (await w.client.query<{ ref_id: string }>("SELECT ref_id FROM offering.subscriptions WHERE id = $1", [r.subscriptionId])).rows[0]?.ref_id ?? "";
    await mintOnChain(w, o.d, refA, inv.wallet, 60n);
    await w.of("settle", { offeringId: o.id, actor: OF.system });
    // A re-run of the settlement job changes nothing and notifies nothing.
    await w.of("settle", { offeringId: o.id, actor: OF.system });
    expect(await count(inv.subjectId, "offering.units_issued")).toBe(1);
    expect(await count(b.inv.subjectId, "offering.units_issued")).toBe(0);
    expect(await kindsOf(w.pool, inv.subjectId)).toEqual([
      "security.kyc_status_changed",
      "security.payout_account_added",
      "offering.reserved",
      "offering.payment_received",
      "offering.allocated",
      "offering.units_issued",
    ]);
  }, 240_000);

  it("officers hear about a request waiting for their duty, never about their own request", async () => {
    const o = await liveOffering(w, { cap: 50n, maxUnits: 50n });
    await paidInvestor(o, 50n);
    await ageClose(w, o.id);
    const t = await w.of("tick", { offeringId: o.id, actor: OF.system });
    const req = String(t.proposed);
    // L11 needs the trustee duty: the trustee duty holder is told, the operations checker is not.
    const trustee = (await notesOf(w.pool, "officer", OF.trustee, "officer.action_waiting")).filter((n) => n.key.startsWith(`offering:request:${req}:`));
    expect(trustee).toHaveLength(1);
    expect(trustee[0]?.params).toEqual({ queue: "offering_request", reference: `OR-${req}` });
    expect((await notesOf(w.pool, "officer", OF.checker, "officer.action_waiting")).filter((n) => n.key.startsWith(`offering:request:${req}:`))).toHaveLength(0);
    // A request made by an officer is not announced to that officer.
    await w.of("decide", { requestId: req, officer: OF.trustee, approve: true, reason: "paid units confirmed with the bank" });
    await w.of("prepareBatch", { offeringId: o.id, actor: OF.maker, reason: "issuance batch from the allocations" });
    const { rows } = await w.client.query<{ id: string }>("SELECT id::text FROM offering.requests WHERE offering_id = $1 AND code = 'IB'", [o.id]);
    const ib = rows[0]?.id ?? "";
    const forIb = async (h: string) => (await notesOf(w.pool, "officer", h, "officer.action_waiting")).filter((n) => n.key.startsWith(`offering:request:${ib}:`));
    expect(await forIb(OF.maker)).toHaveLength(0);
    expect(await forIb(OF.checker)).toHaveLength(1);
    expect(await forIb(OF.checker2)).toHaveLength(1);
    expect(await forIb(OF.trustee)).toHaveLength(1);
    expect(await forIb(OF.compliance)).toHaveLength(0);
  }, 180_000);

  it("waiting list, cancellation, promotion and expiry; the expiring reminder is swept once; a rolled-back cancel notifies nothing", async () => {
    const o = await liveOffering(w, { cap: 20n, maxUnits: 20n });
    const a = await investor(w, o.d);
    const b = await investor(w, o.d);
    await accept(w, o.id, a, o.docs);
    await accept(w, o.id, b, o.docs);
    const ra = await reserve(w, o.id, a, 20n);
    const rb = await reserve(w, o.id, b, 20n);
    expect(rb.state).toBe("waitlisted");
    expect(await count(b.subjectId, "offering.waitlisted")).toBe(1);

    // Rollback: the cancellation and its notification disappear together.
    const c = await w.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT offering.cancel($1, $2, $3)", [ra.subscriptionId, a.subjectId, `investor:${a.subjectId}`]);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
    expect(await subState(w, ra.subscriptionId)).toBe("payment_pending");
    expect(await count(a.subjectId, "offering.reservation_cancelled")).toBe(0);
    expect(await count(b.subjectId, "offering.reserved")).toBe(0);

    await w.of("cancel", { subscriptionId: ra.subscriptionId, subjectId: a.subjectId, actor: `investor:${a.subjectId}` });
    expect(await count(a.subjectId, "offering.reservation_cancelled")).toBe(1);
    // B is promoted from the waiting list in the same transaction.
    expect(await subState(w, rb.subscriptionId)).toBe("payment_pending");
    expect(await count(b.subjectId, "offering.reserved")).toBe(1);

    // Two hours before expiry (reserved more than 30 minutes ago): one reminder, however often the sweep runs.
    await w.client.query("ALTER TABLE offering.subscriptions DISABLE TRIGGER subscriptions_guard");
    try {
      await w.client.query("UPDATE offering.subscriptions SET reserved_at = now() - interval '3 hours', expires_at = now() + interval '1 hour' WHERE id = $1", [rb.subscriptionId]);
    } finally {
      await w.client.query("ALTER TABLE offering.subscriptions ENABLE TRIGGER subscriptions_guard");
    }
    expect((await sweep(w.pool)).reservationExpiring).toBeGreaterThanOrEqual(1);
    await sweep(w.pool);
    const expiring = await notesOf(w.pool, "investor", b.subjectId, "offering.reservation_expiring");
    expect(expiring).toHaveLength(1);
    expect(expiring[0]?.params.offering).toBe(`OF-${o.id.replace(/-/g, "").slice(0, 6).toUpperCase()}`);

    await ageReservation(w, rb.subscriptionId);
    await w.of("tick", { offeringId: o.id, actor: OF.system });
    await w.of("tick", { offeringId: o.id, actor: OF.system });
    expect(await subState(w, rb.subscriptionId)).toBe("expired");
    expect(await count(b.subjectId, "offering.reservation_expired")).toBe(1);
  }, 180_000);

  it("refunds after a failed offering: refund pending and refunded, once each", async () => {
    const o = await liveOffering(w, { cap: 100n, maxUnits: 50n });
    const a = await paidInvestor(o, 30n);
    await ageClose(w, o.id);
    const t = await w.of("tick", { offeringId: o.id, actor: OF.system });
    await w.of("decide", { requestId: String(t.proposed), officer: OF.trustee, approve: true, reason: "min raise not met, confirmed" });
    expect(await subState(w, a.sub)).toBe("refund_pending");
    expect(await count(a.inv.subjectId, "offering.refund_pending")).toBe(1);
    // Two bank operators approve the refund (V20): each is told it waits for them, once.
    expect((await notesOf(w.pool, "officer", OF.bank1, "officer.action_waiting")).filter((n) => n.params.queue === "offering_request").length).toBeGreaterThanOrEqual(1);
    await w.of("decideAll", { offeringId: o.id, code: "V20", officer: OF.bank1, approve: true, reason: "refund list checked against the ledger" });
    await w.of("decideAll", { offeringId: o.id, code: "V20", officer: OF.bank2, approve: true, reason: "second operator checked the list" });
    await passRecon(w);
    await executeApprovedRefunds(w.pool, w.mock, o.id, OF.system);
    await executeApprovedRefunds(w.pool, w.mock, o.id, OF.system);
    expect(await subState(w, a.sub)).toBe("refunded");
    const refunded = await notesOf(w.pool, "investor", a.inv.subjectId, "offering.refunded");
    expect(refunded).toHaveLength(1);
    expect(refunded[0]?.params.amount_paisa).toBe(String(30n * o.price));
  }, 180_000);

  it("a blocked subscription tells the investor nothing (NP-4); unmatched payments are told generically, once", async () => {
    const o = await liveOffering(w, { cap: 100n, maxUnits: 50n });
    const a = await paidInvestor(o, 10n);
    const before = await kindsOf(w.pool, a.inv.subjectId);
    expect(await w.of("block", { subscriptionId: a.sub, officer: OF.compliance, reason: "sanctions list update: possible match under review" })).toBe("blocked");
    expect(await kindsOf(w.pool, a.inv.subjectId)).toEqual(before);

    // Wrong amount with a valid code: suspense, one generic notice; the bank re-sending it changes nothing.
    const c = await investor(w, o.d);
    await accept(w, o.id, c, o.docs);
    const rc = await reserve(w, o.id, c, 10n);
    const ref = await pay(w, c, rc.paymentCode, BigInt(rc.amountPaisa) + 1n);
    const unmatched = await notesOf(w.pool, "investor", c.subjectId, "bank.payment_unmatched");
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]?.key).toBe(`bank:credit:${ref}:unmatched`);
    expect(unmatched[0]?.params.amount_paisa).toBe(String(BigInt(rc.amountPaisa) + 1n));
    // A payment from someone else's account with the investor's code: the investor hears about it too.
    const stranger = makeIban("MEZN", String(Date.now()).padStart(16, "0"));
    w.mock.openAccount(stranger, "Someone Else");
    await pay(w, c, rc.paymentCode, BigInt(rc.amountPaisa), stranger);
    expect(await count(c.subjectId, "bank.payment_unmatched")).toBe(2);
  }, 180_000);

  it("marketing at L5 reaches only investors who opted in (NP-5)", async () => {
    const secrets = ContactSecrets.of(randomBytes(32), randomBytes(32));
    const svc = new NotifyService(w.pool, secrets);
    const keen = { type: "investor" as const, id: randomUUID() };
    const quiet = { type: "investor" as const, id: randomUUID() };
    const keenId = await svc.registerRecipient(keen, "ur", "web");
    const quietId = await svc.registerRecipient(quiet, "en", "web");
    await svc.registerContact(keenId, "email", contacts().email, "web");
    await svc.registerContact(quietId, "email", contacts().email, "web");
    await svc.setMarketingConsent(keenId, "email", true, "mkt-2026-10", "web");
    const o = await liveOffering(w, { cap: 10n, maxUnits: 10n });
    const keenNotes = await notesOf(w.pool, "investor", keen.id, "marketing.offering_open");
    expect(keenNotes).toHaveLength(1);
    expect(keenNotes[0]).toMatchObject({ status: "queued", key: `offering:open:${o.id}:${keen.id}` });
    expect(await notesOf(w.pool, "investor", quiet.id)).toEqual([]);
  }, 180_000);

  it("no producer failed and the notify audit chain verifies", async () => {
    expect(await producerFailureCount(w.pool)).toBe(0);
    expect(await verifyAudit(w.pool)).toEqual([]);
  });
});
