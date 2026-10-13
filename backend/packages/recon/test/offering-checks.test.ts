import { describe, expect, it } from "vitest";
import { checkIssuance, checkOfferings, runChecks } from "../src/checks.ts";
import { refIdForSubscription } from "../src/conventions.ts";
import type { CheckName, Finding, OfferingSubscription, ReconData } from "../src/types.ts";
import { AS_OF, makeWorld, type World } from "./world.ts";

/**
 * Offering checks (S-02 §8) and the ADR 0007 amendment: for an offering subscription the
 * paid -> minted SLA starts when the offering's mint window opens, never at payment.
 */

const minutesAgo = (m: number): Date => new Date(AS_OF.getTime() - m * 60_000);
const names = (fs: Finding[]): CheckName[] => fs.map((x) => x.check);
const uuidOf = (i: number): string => `00000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, "0")}`;

/** settled (0), refunded (1), paid and waiting (2): all web-keyed, so refId = keccak(subscription id). */
function world(): World {
  return makeWorld({
    subs: [
      { outcome: "settled", tokens: 10, paisaPerToken: 1_000, wallet: 0, web: true },
      { outcome: "refunded", tokens: 3, paisaPerToken: 1_000, wallet: 1, web: true },
      { outcome: "pending", tokens: 5, paisaPerToken: 1_000, wallet: 2, web: true },
    ],
    rent: [],
  });
}

function withOffering(w: World, over: { state?: string[]; offeringState?: string; mintStartedAt?: Date | null; failedAt?: Date | null; hardCap?: bigint } = {}): ReconData {
  const states = over.state ?? ["tokens_issued", "refunded", "allocation_pending"];
  const subscriptions: OfferingSubscription[] = w.subs.map((s, i) => ({
    subscriptionId: uuidOf(i),
    token: w.data.deployment.token,
    refId: s.refId,
    offeringId: "off-1",
    offeringState: over.offeringState ?? "completing",
    hardCap: over.hardCap ?? 100n,
    mintStartedAt: over.mintStartedAt === undefined ? minutesAgo(5) : over.mintStartedAt,
    failedAt: over.failedAt ?? null,
    state: states.at(i) ?? "expired",
    units: s.tokens,
    wallet: s.wallet,
    amountPaisa: s.amount,
  }));
  return { ...w.data, offerings: { subscriptions, refundSlaMs: 48 * 3_600_000, trusteeCap: 1_000n, paymentAnomalies: [] } };
}

const agePaid = (w: World, minutes: number): void => {
  const p = w.subs[2];
  const j = w.data.ledger.journals.find((x) => x.key === `web:sub:${uuidOf(2)}:paid`);
  if (!p || !j) throw new Error("fixture");
  j.createdAt = minutesAgo(minutes);
};

describe("issuance.paid_not_minted starts at the mint window for offering subscriptions", () => {
  it("without offering data the old rule applies: paid two hours ago and unminted is blocking", () => {
    const w = world();
    agePaid(w, 120);
    expect(w.subs.map((s, i) => refIdForSubscription(uuidOf(i)) === s.refId)).toEqual([true, true, true]);
    expect(names(checkIssuance(w.data))).toEqual(["issuance.paid_not_minted"]);
  });

  it("an open or funded offering (no mint window yet) raises nothing however old the payment", () => {
    const w = world();
    agePaid(w, 60 * 24 * 30);
    expect(checkIssuance(withOffering(w, { offeringState: "funded", mintStartedAt: null }))).toEqual([]);
    expect(checkIssuance(withOffering(w, { offeringState: "live", mintStartedAt: null, state: ["tokens_issued", "refunded", "payment_confirmed"] }))).toEqual([]);
  });

  it("measures from the mint window: in flight within the SLA, blocking after it", () => {
    const w = world();
    agePaid(w, 600);
    expect(checkIssuance(withOffering(w, { mintStartedAt: minutesAgo(29) }))).toEqual([]);
    const late = checkIssuance(withOffering(w, { mintStartedAt: minutesAgo(31) }));
    expect(names(late)).toEqual(["issuance.paid_not_minted"]);
    expect(late[0]?.actual).toMatch(/mint window opened/);
  });

  it("uses the mint window of another token's offering too (journals are shared), without checking that offering here", () => {
    const w = world();
    agePaid(w, 600);
    const d = withOffering(w, { offeringState: "funded", mintStartedAt: null, state: ["tokens_issued", "refunded", "allocation_pending"] });
    for (const x of d.offerings?.subscriptions ?? []) x.token = "0x00000000000000000000000000000000000000bb";
    expect(checkIssuance(d)).toEqual([]);
    expect(checkOfferings(d)).toEqual([]);
  });

  it("a refund-pending or blocked allocation is not expected to be minted", () => {
    const w = world();
    agePaid(w, 600);
    for (const s of ["refund_pending", "blocked", "disputed"]) {
      expect(checkIssuance(withOffering(w, { mintStartedAt: minutesAgo(600), state: ["tokens_issued", "refunded", s] }))).toEqual([]);
    }
  });
});

describe("checkOfferings", () => {
  it("is quiet for consistent data and the whole run stays clean", () => {
    const w = world();
    const d = withOffering(w);
    expect(checkOfferings(d)).toEqual([]);
    expect(runChecks(d)).toEqual([]);
    expect(checkOfferings(w.data)).toEqual([]); // no offering data: nothing to check
  });

  it("finds a state that disagrees with the ledger, and the escrow difference it causes", () => {
    const w = world();
    expect(names(checkOfferings(withOffering(w, { state: ["tokens_issued", "refunded", "payment_pending"] })))).toEqual(["offering.state_mismatch", "offering.escrow_mismatch"]);
    expect(names(checkOfferings(withOffering(w, { state: ["allocation_pending", "refunded", "allocation_pending"] })))).toEqual(
      expect.arrayContaining(["offering.state_mismatch", "offering.escrow_mismatch"]),
    );
    expect(names(checkOfferings(withOffering(w, { state: ["tokens_issued", "refund_pending", "allocation_pending"] })))).toContain("offering.state_mismatch");
  });

  it("finds a refId that is not the subscription's", () => {
    const d = withOffering(world());
    const s0 = d.offerings?.subscriptions[0];
    if (!s0) throw new Error("fixture");
    s0.subscriptionId = uuidOf(9);
    expect(names(checkOfferings(d))).toEqual(["offering.ref_id_mismatch"]);
  });

  it("finds units held above the hard cap", () => {
    expect(names(checkOfferings(withOffering(world(), { hardCap: 14n })))).toEqual(["offering.over_hard_cap"]);
    expect(checkOfferings(withOffering(world(), { hardCap: 15n }))).toEqual([]);
  });

  it("finds a mint outside the mint window", () => {
    expect(names(checkOfferings(withOffering(world(), { mintStartedAt: null, offeringState: "funded" })))).toEqual(["offering.mint_outside_window"]);
  });

  it("warns about refunds after a failure, and reports them as overdue after the SLA (a warning: a freeze would stop the refunds)", () => {
    const w = world();
    const d = (h: number): ReconData => withOffering(w, { offeringState: "refunding", failedAt: minutesAgo(h * 60), state: ["tokens_issued", "refunded", "refund_pending"] });
    expect(checkOfferings(d(47)).map((x) => `${x.check}:${x.severity}`)).toEqual(["offering.paid_after_failure:warning"]);
    expect(checkOfferings(d(49)).map((x) => `${x.check}:${x.severity}`)).toEqual(["offering.refund_overdue:warning"]);
  });

  it("at completion, minted units equal settled units; the cap covers what is left to mint", () => {
    const w = world();
    expect(names(checkOfferings(withOffering(w, { offeringState: "completed", state: ["active", "refunded", "active"] })))).toEqual(
      expect.arrayContaining(["offering.allocation_mismatch"]),
    );
    const d = withOffering(w);
    if (d.offerings) d.offerings.trusteeCap = 14n;
    expect(names(checkOfferings(d))).toEqual(["offering.cap_headroom"]);
  });

  it("reports a payment that reached a subscription no longer waiting for it", () => {
    const d = withOffering(world());
    d.offerings?.paymentAnomalies.push({ subscriptionId: uuidOf(1), raastRef: "RAAST-X1", state: "cancelled" });
    expect(names(checkOfferings(d))).toEqual(["offering.payment_anomaly"]);
  });
});
