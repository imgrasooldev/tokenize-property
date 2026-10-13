import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeApprovedRefunds, OfferingError } from "../src/service.ts";
import {
  accept,
  ageClose,
  ageReservation,
  hex32,
  investor,
  liveOffering,
  makeWorld,
  mintOnChain,
  money,
  OF,
  offeringState,
  passRecon,
  pay,
  reserve,
  units,
  type Investor,
  type Offering,
  type World,
} from "./world.ts";

/**
 * Property test (S-02 §14): random streams of reservations, exact and inexact payments,
 * cancellations and expiries, then the close, run against the database and against a small
 * reference model of FCFS with a strict waitlist. After every step: the database agrees with the
 * model subscription by subscription, units held and paid never exceed the hard cap, and money is
 * conserved (paid = refunded + settled + held). At the end every paid subscription is either
 * settled (funded) or refunded to its sender (failed).
 */

const CAP = 60n;
const MAX = 30n;
let w: World;
const pool: Investor[] = [];
const INVESTORS = 5;

beforeAll(async () => {
  w = await makeWorld();
  const first = await liveOffering(w, { cap: CAP, maxUnits: MAX });
  for (let i = 0; i < INVESTORS; i++) pool.push(await investor(w, first.d));
}, 180_000);
afterAll(async () => {
  await w.drop();
}, 120_000);

type Cmd =
  | { t: "reserve"; i: number; units: bigint }
  | { t: "payExact"; i: number }
  | { t: "payWrong"; i: number }
  | { t: "payThird"; i: number }
  | { t: "cancel"; i: number }
  | { t: "expire"; i: number };

// Reservations and exact payments are weighted up, so runs reach a full offering and the waitlist.
const cmd: fc.Arbitrary<Cmd> = fc.oneof(
  { arbitrary: fc.record({ t: fc.constant("reserve" as const), i: fc.nat(INVESTORS - 1), units: fc.constantFrom(10n, 20n, 30n) }), weight: 5 },
  { arbitrary: fc.record({ t: fc.constant("payExact" as const), i: fc.nat(INVESTORS - 1) }), weight: 4 },
  { arbitrary: fc.record({ t: fc.constant("payWrong" as const), i: fc.nat(INVESTORS - 1) }), weight: 1 },
  { arbitrary: fc.record({ t: fc.constant("payThird" as const), i: fc.nat(INVESTORS - 1) }), weight: 1 },
  { arbitrary: fc.record({ t: fc.constant("cancel" as const), i: fc.nat(INVESTORS - 1) }), weight: 2 },
  { arbitrary: fc.record({ t: fc.constant("expire" as const), i: fc.nat(INVESTORS - 1) }), weight: 2 },
);

interface MSub {
  id: string;
  i: number;
  units: bigint;
  amount: bigint;
  state: string;
  code: string | null;
}

const HELD = new Set(["payment_pending", "payment_confirmed", "allocation_pending", "issuance_review", "tokens_issued", "active", "refund_pending"]);
const OPEN = new Set(["payment_pending", "waitlisted"]);

/** The reference model: FCFS with a strict waitlist, nothing else. */
class Model {
  subs: MSub[] = [];
  constructor(readonly price: bigint) {}
  held(): bigint {
    return this.subs.filter((s) => HELD.has(s.state)).reduce((a, s) => a + s.units, 0n);
  }
  latest(i: number): MSub | undefined {
    return [...this.subs].reverse().find((s) => s.i === i);
  }
  open(i: number): MSub | undefined {
    return this.subs.find((s) => s.i === i && OPEN.has(s.state));
  }
  investorHeld(i: number): bigint {
    return this.subs.filter((s) => s.i === i && HELD.has(s.state)).reduce((a, s) => a + s.units, 0n);
  }
  /** Expected state of a new request (null = refused before a subscription exists). */
  request(i: number, u: bigint): string | null {
    if (this.open(i)) return null;
    if (this.investorHeld(i) + u > MAX) return "rejected";
    if (this.subs.some((s) => s.state === "waitlisted") || u > CAP - this.held()) return "waitlisted";
    return "payment_pending";
  }
  /** Strict FIFO promotion; returns the promoted subscriptions. */
  promote(): MSub[] {
    const out: MSub[] = [];
    for (const s of this.subs.filter((x) => x.state === "waitlisted")) {
      if (s.units > CAP - this.held()) break;
      s.state = "payment_pending";
      out.push(s);
    }
    return out;
  }
}

async function dbStates(offeringId: string): Promise<Map<string, { state: string; code: string | null }>> {
  const { rows } = await w.client.query<{ id: string; state: string; intent_code: string | null }>("SELECT id, state, intent_code FROM offering.subscriptions WHERE offering_id = $1", [offeringId]);
  return new Map(rows.map((r) => [r.id, { state: r.state, code: r.intent_code }]));
}

async function check(o: Offering, m: Model): Promise<void> {
  const db = await dbStates(o.id);
  expect(db.size).toBe(m.subs.length);
  for (const s of m.subs) {
    expect(db.get(s.id)?.state, `subscription ${s.id}`).toBe(s.state);
    s.code = db.get(s.id)?.code ?? null;
  }
  const u = await units(w, o.id);
  expect(u.held).toBe(m.held());
  expect(u.held).toBeLessThanOrEqual(CAP);
  expect(u.paid).toBeLessThanOrEqual(CAP);
  const money_ = await money(w, o.id);
  expect(money_.paid).toBe(money_.refunded + money_.settled + money_.held);
  const paidModel = m.subs.filter((s) => ["payment_confirmed", "allocation_pending", "tokens_issued", "active", "refund_pending", "refunded"].includes(s.state)).reduce((a, s) => a + s.amount, 0n);
  expect(money_.paid).toBe(paidModel);
}

async function apply(o: Offering, m: Model, c: Cmd): Promise<void> {
  const inv = pool[c.i] as Investor;
  const actor = `investor:${inv.subjectId}`;
  switch (c.t) {
    case "reserve": {
      const expected = m.request(c.i, c.units);
      try {
        const r = await reserve(w, o.id, inv, c.units);
        expect(expected).not.toBeNull();
        expect(r.state).toBe(expected);
        m.subs.push({ id: r.subscriptionId, i: c.i, units: c.units, amount: c.units * o.price, state: r.state, code: r.paymentCode });
      } catch (e) {
        if (!(e instanceof OfferingError)) throw e;
        expect(expected).toBeNull();
        expect(e.code).toBe("DUPLICATE");
      }
      return;
    }
    case "payExact":
    case "payWrong":
    case "payThird": {
      const s = [...m.subs].reverse().find((x) => x.i === c.i && x.code);
      if (!s?.code) return;
      const from = c.t === "payThird" ? (pool[(c.i + 1) % INVESTORS] as Investor).iban : inv.iban;
      await pay(w, inv, s.code, c.t === "payWrong" ? s.amount - 1n : s.amount, from);
      if (c.t === "payExact" && s.state === "payment_pending") s.state = "payment_confirmed";
      return;
    }
    case "cancel": {
      const s = m.latest(c.i);
      if (!s) return;
      try {
        await w.of("cancel", { subscriptionId: s.id, subjectId: inv.subjectId, actor });
        expect(OPEN.has(s.state)).toBe(true);
        s.state = "cancelled";
        m.promote();
      } catch (e) {
        if (!(e instanceof OfferingError)) throw e;
        expect(OPEN.has(s.state)).toBe(false);
      }
      return;
    }
    case "expire": {
      const s = m.latest(c.i);
      if (s?.state !== "payment_pending") return;
      await ageReservation(w, s.id);
      await w.of("tick", { offeringId: o.id, actor: OF.system });
      s.state = "expired";
      m.promote();
      return;
    }
  }
}

/** The close: unpaid and waiting subscriptions expire; all-or-nothing decides; refunds or completion follow. */
async function close(o: Offering, m: Model): Promise<void> {
  await ageClose(w, o.id);
  const t = await w.of("tick", { offeringId: o.id, actor: OF.system });
  for (const s of m.subs) if (OPEN.has(s.state)) s.state = "expired";
  expect(t.state).toBe("closing");
  await check(o, m);
  const paid = m.subs.filter((s) => s.state === "payment_confirmed");
  const funded = paid.reduce((a, s) => a + s.units, 0n) >= CAP;
  await w.of("decide", { requestId: String(t.proposed), officer: OF.trustee, approve: true, reason: "outcome confirmed by the trustee" });
  if (!funded) {
    for (const s of paid) s.state = "refund_pending";
    await check(o, m);
    await w.of("decideAll", { offeringId: o.id, code: "V20", officer: OF.bank1, approve: true, reason: "refund list checked against the ledger" });
    await w.of("decideAll", { offeringId: o.id, code: "V20", officer: OF.bank2, approve: true, reason: "second operator checked the list" });
    await passRecon(w);
    await executeApprovedRefunds(w.pool, w.mock, o.id, OF.system);
    for (const s of paid) s.state = "refunded";
    await check(o, m);
    expect(await offeringState(w, o.id)).toBe("cancelled");
    const mm = await money(w, o.id);
    expect(mm.held).toBe(0n);
    expect(mm.refunded).toBe(mm.paid);
    return;
  }
  for (const s of paid) s.state = "allocation_pending";
  await check(o, m);
  await w.of("prepareBatch", { offeringId: o.id, actor: OF.maker, reason: "issuance batch from the allocations" });
  await w.of("decideAll", { offeringId: o.id, code: "IB", officer: OF.checker, approve: true, reason: "batch checked against allocations" });
  await w.of("decideAll", { offeringId: o.id, code: "IB", officer: OF.trustee, approve: true, reason: "batch checked against the register" });
  const conditions = Object.fromEntries(["encumbrances_discharged", "sale_deed_ready", "approvals_consents", "insurance", "trust_deed_executed", "register_ready"].map((k) => [k, hex32()]));
  const l13 = await w.of("request", { offeringId: o.id, code: "L13", actor: OF.maker, reason: "all conditions precedent evidenced", detail: { conditions } });
  await w.of("decide", { requestId: l13, officer: OF.checker2, approve: true, reason: "conditions evidence reviewed" });
  await w.of("decide", { requestId: l13, officer: OF.trustee, approve: true, reason: "trustee agrees to complete" });
  const cmp = await w.of("request", {
    offeringId: o.id,
    code: "CMP",
    actor: OF.maker,
    reason: "sale deed registered, seller paid",
    detail: { deedSha: hex32(), deedRegistration: "Sub-Registrar Cantt 7/2026", batchReference: "PTCMP-0007", batchFileSha: hex32() },
  });
  await w.of("decide", { requestId: cmp, officer: OF.trustee, approve: true, reason: "deed and payments verified" });
  expect(await w.of("startMinting", { offeringId: o.id, actor: OF.system })).toBe(paid.length);
  const { rows } = await w.client.query<{ ref_id: string; wallet: string; units: string }>(
    "SELECT ref_id, wallet, units::text FROM offering.subscriptions WHERE offering_id = $1 AND state = 'allocation_pending'",
    [o.id],
  );
  for (const r of rows) await mintOnChain(w, o.d, r.ref_id, r.wallet, BigInt(r.units));
  await w.of("settle", { offeringId: o.id, actor: OF.system });
  for (const s of paid) s.state = "tokens_issued";
  await check(o, m);
  const mm = await money(w, o.id);
  expect(mm.settled).toBe(mm.paid);
}

describe("offering model (fast-check)", () => {
  it("agrees with the reference model, never over-allocates and conserves money", async () => {
    let runs = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(cmd, { minLength: 6, maxLength: 16 }), async (cmds) => {
        runs++;
        const o = await liveOffering(w, { cap: CAP, maxUnits: MAX });
        for (const inv of pool) {
          await w.client.query("INSERT INTO chain.investors (registry, wallet, identity, country, registered, updated_block) VALUES ($1, $2, $3, 586, true, 0)", [
            o.d.identityRegistry,
            inv.wallet,
            `0x${"1".repeat(40)}`,
          ]);
          await accept(w, o.id, inv, o.docs);
        }
        const m = new Model(o.price);
        for (const c of cmds) {
          await apply(o, m, c);
          await check(o, m);
        }
        await close(o, m);
      }),
      // A funded run (60 units paid) needs several reservations and payments: bias towards them.
      {
        numRuns: 30,
        endOnFailure: true,
        examples: [
          [[{ t: "reserve", i: 0, units: 30n }, { t: "reserve", i: 1, units: 30n }, { t: "payExact", i: 0 }, { t: "payExact", i: 1 }]],
          [[{ t: "reserve", i: 0, units: 30n }, { t: "reserve", i: 1, units: 30n }, { t: "reserve", i: 2, units: 10n }, { t: "cancel", i: 0 }, { t: "payExact", i: 1 }, { t: "payExact", i: 2 }]],
        ],
      },
    );
    expect(runs).toBeGreaterThanOrEqual(30);
  }, 900_000);
});
