import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OfferingError } from "../src/service.ts";
import { accept, ageReservation, investor, liveOffering, makeWorld, OF, pay, reserve, subState, units, type Investor, type World } from "./world.ts";

/**
 * Racing investors (S-02 acceptance 2): concurrent reservations, payments, cancellations and expiries
 * never hold or collect more than the hard cap, and every credit ends either matched to a waiting
 * reservation or in suspense.
 */

let w: World;
beforeAll(async () => {
  w = await makeWorld();
}, 120_000);
afterAll(async () => {
  await w.drop();
}, 120_000);

const settle = async <T>(ps: Promise<T>[]): Promise<(T | Error)[]> => (await Promise.allSettled(ps)).map((r) => (r.status === "fulfilled" ? r.value : (r.reason as Error)));
const settleAll = async (ps: Promise<unknown>[]): Promise<unknown[]> => settle(ps);

describe("oversubscription race", () => {
  it("12 investors reserve 20 units each at once on a 100-unit offering: 5 reserved, 7 waitlisted, never over the cap", async () => {
    const o = await liveOffering(w, { cap: 100n, maxUnits: 20n });
    const invs: Investor[] = [];
    for (let i = 0; i < 12; i++) {
      const inv = await investor(w, o.d);
      await accept(w, o.id, inv, o.docs);
      invs.push(inv);
    }
    const results = await settle(invs.map((inv) => reserve(w, o.id, inv, 20n)));
    const states = results.map((r) => (r instanceof Error ? `error:${r.message}` : r.state));
    expect(states.filter((s) => s === "payment_pending")).toHaveLength(5);
    expect(states.filter((s) => s === "waitlisted")).toHaveLength(7);
    expect((await units(w, o.id)).held).toBe(100n);

    // All 5 pay at once while 2 of them also cancel at once: a payment and a cancellation of the
    // same code serialise on the bank's lock; whichever comes first wins, never both.
    const reserved = results.flatMap((r, i) => (r instanceof Error || r.state !== "payment_pending" ? [] : [{ r, inv: invs.at(i) as Investor }]));
    const races = await settleAll([
      ...reserved.map(({ r, inv }) => pay(w, inv, r.paymentCode, BigInt(r.amountPaisa))),
      ...reserved.slice(0, 2).map(({ r, inv }) => w.of("cancel", { subscriptionId: r.subscriptionId, subjectId: inv.subjectId, actor: `investor:${inv.subjectId}` })),
    ]);
    for (const x of races) if (x instanceof Error) expect(x).toBeInstanceOf(OfferingError); // a refused cancel (already paid)
    const after = await Promise.all(reserved.map(({ r }) => subState(w, r.subscriptionId)));
    expect(after.slice(2).every((s) => s === "payment_confirmed")).toBe(true);
    for (const s of after.slice(0, 2)) expect(["payment_confirmed", "cancelled"]).toContain(s);
    // Every cancellation freed units for the waitlist, still within the cap.
    const u = await units(w, o.id);
    expect(u.held).toBeLessThanOrEqual(100n);
    expect(u.paid).toBeLessThanOrEqual(100n);
    // Money: each credit of the race is matched exactly when its subscription is paid.
    const { rows } = await w.client.query<{ matched: string; paid: string }>(
      `SELECT (SELECT count(*) FROM bank.credits c JOIN offering.subscriptions s ON s.intent_code = c.intent_code AND c.status = 'matched' WHERE s.offering_id = $1)::text AS matched,
              (SELECT count(*) FROM offering.subscriptions WHERE offering_id = $1 AND paid_journal IS NOT NULL)::text AS paid`,
      [o.id],
    );
    expect(rows[0]?.matched).toBe(rows[0]?.paid);
  }, 240_000);

  it("expiry jobs, cancellations and new reservations racing with promotions never exceed the cap", async () => {
    const o = await liveOffering(w, { cap: 60n, maxUnits: 30n });
    const invs: Investor[] = [];
    for (let i = 0; i < 8; i++) {
      const inv = await investor(w, o.d);
      await accept(w, o.id, inv, o.docs);
      invs.push(inv);
    }
    const first = await Promise.all(invs.slice(0, 4).map((inv) => reserve(w, o.id, inv, 30n)));
    expect(first.filter((r) => r.state === "payment_pending")).toHaveLength(2);
    const pendingSubs = first.filter((r) => r.state === "payment_pending");
    for (const r of pendingSubs) await ageReservation(w, r.subscriptionId);
    // Two expiry jobs, two new investors and a cancellation of a waitlisted entry, all at once.
    const waitlisted = first.find((r) => r.state === "waitlisted");
    const wInv = invs.at(waitlisted ? first.indexOf(waitlisted) : 0) as Investor;
    await settleAll([
      w.of("tick", { offeringId: o.id, actor: OF.system }),
      w.of("tick", { offeringId: o.id, actor: "system:second-clock" }),
      ...invs.slice(4, 6).map((inv) => reserve(w, o.id, inv, 30n)),
      ...(waitlisted ? [w.of("cancel", { subscriptionId: waitlisted.subscriptionId, subjectId: wInv.subjectId, actor: `investor:${wInv.subjectId}` })] : []),
    ]);
    const u = await units(w, o.id);
    expect(u.held).toBeLessThanOrEqual(60n);
    expect(u.reserved).toBe(u.held);
    for (const r of pendingSubs) expect(await subState(w, r.subscriptionId)).toBe("expired");
  }, 240_000);
});
