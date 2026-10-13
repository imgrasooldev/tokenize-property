import { reconcile, type ChainState, type Finding } from "@pt/recon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeApprovedRefunds } from "../src/service.ts";
import {
  accept,
  ageClose,
  ageFailure,
  hex32,
  investor,
  liveOffering,
  makeWorld,
  mintOnChain,
  OF,
  pay,
  reserve,
  type Investor,
  type Offering,
  type World,
} from "./world.ts";

/**
 * Reconciliation before, during and after an offering, with the real loader and checks against the
 * scratch database (ADR 0007 amendment): a normal open or funded offering raises no blocking finding
 * (the paid -> minted SLA starts at the mint window, not at payment), an overdue mint window and an
 * overdue refund do.
 */

let w: World;
beforeAll(async () => {
  w = await makeWorld();
}, 120_000);
afterAll(async () => {
  await w.drop();
}, 120_000);

/** The chain answers what the read model holds (the indexer is exact at the pinned block). */
function chainOf(): ChainState {
  return {
    head: async () => BigInt((await w.client.query<{ n: string }>("SELECT coalesce(max(number), 0)::text AS n FROM chain.blocks")).rows[0]?.n ?? "0"),
    totalSupply: async (token) => BigInt((await w.client.query<{ s: string }>("SELECT total_supply::text AS s FROM chain.tokens WHERE token = $1", [token])).rows[0]?.s ?? "0"),
    balances: async (token, holders) => {
      const { rows } = await w.client.query<{ holder: string; balance: string }>("SELECT holder, balance::text FROM chain.holdings WHERE token = $1 AND holder = ANY($2)", [token, holders]);
      return new Map(rows.map((r) => [r.holder, BigInt(r.balance)]));
    },
  };
}

async function run(o: Offering): Promise<Finding[]> {
  const r = await reconcile(w.pool, {
    deployment: { id: o.d.id, chainId: 586586, fromBlock: 0n, contracts: { token: o.d.token as `0x${string}`, issuance: o.d.issuance as `0x${string}`, identityRegistry: o.d.identityRegistry as `0x${string}` } },
    chain: chainOf(),
    actor: "test:recon",
    verifyIndexer: null,
  });
  if (r.error) throw new Error(r.error);
  return r.findings;
}
const blocking = (fs: Finding[]): string[] => fs.filter((x) => x.severity === "blocking").map((x) => `${x.check} ${x.subject}`);

async function paid(o: Offering, n: bigint): Promise<{ inv: Investor; sub: string }> {
  const inv = await investor(w, o.d);
  await accept(w, o.id, inv, o.docs);
  const r = await reserve(w, o.id, inv, n);
  await pay(w, inv, r.paymentCode, BigInt(r.amountPaisa));
  return { inv, sub: r.subscriptionId };
}

async function ageMintWindow(o: Offering, minutes: number): Promise<void> {
  await w.client.query("ALTER TABLE offering.offerings DISABLE TRIGGER USER");
  try {
    await w.client.query("UPDATE offering.offerings SET mint_started_at = mint_started_at - make_interval(mins => $2) WHERE id = $1", [o.id, minutes]);
  } finally {
    await w.client.query("ALTER TABLE offering.offerings ENABLE TRIGGER USER");
  }
}

/** Paid subscriptions older than the SLA (as if paid an hour ago): the old rule would flag them. */
async function agePayments(minutes: number): Promise<void> {
  await w.client.query("ALTER TABLE ledger.journal DISABLE TRIGGER USER");
  try {
    await w.client.query("UPDATE ledger.journal SET created_at = created_at - make_interval(mins => $1) WHERE idempotency_key LIKE 'sub:%:paid'", [minutes]);
  } finally {
    await w.client.query("ALTER TABLE ledger.journal ENABLE TRIGGER USER");
  }
}

describe("reconciliation of an offering (ADR 0007 amendment)", () => {
  it("a failed offering: pending and overdue refunds are reported without freezing the refunds; refunded is clean", async () => {
    const o = await liveOffering(w, { cap: 100n, maxUnits: 50n });
    await paid(o, 30n);
    await ageClose(w, o.id);
    const t = await w.of("tick", { offeringId: o.id, actor: OF.system });
    await w.of("decide", { requestId: String(t.proposed), officer: OF.trustee, approve: true, reason: "min raise not met, confirmed" });
    const pending = await run(o);
    expect(pending.filter((x) => x.check.startsWith("offering.")).map((x) => `${x.check}:${x.severity}`)).toEqual(["offering.paid_after_failure:warning"]);
    await ageFailure(w, o.id, 49);
    const late = await run(o);
    expect(late.filter((x) => x.check.startsWith("offering.")).map((x) => `${x.check}:${x.severity}`)).toEqual(["offering.refund_overdue:warning"]);
    // The run did not freeze payouts, so the overdue refund can still be sent (it needs the gate).
    expect(blocking(late)).toEqual([]);
    await w.of("decideAll", { offeringId: o.id, code: "V20", officer: OF.bank1, approve: true, reason: "refund list checked against the ledger" });
    await w.of("decideAll", { offeringId: o.id, code: "V20", officer: OF.bank2, approve: true, reason: "second operator checked the list" });
    expect(await executeApprovedRefunds(w.pool, w.mock, o.id, OF.system)).toHaveLength(1);
    const done = await run(o);
    expect(done.filter((x) => x.check.startsWith("offering."))).toEqual([]);
    expect(blocking(done)).toEqual([]);
  }, 240_000);

  it("finds a subscription state that does not match the ledger (and the escrow difference)", async () => {
    const o = await liveOffering(w, { cap: 100n, maxUnits: 50n });
    const a = await paid(o, 10n);
    await w.client.query("ALTER TABLE offering.subscriptions DISABLE TRIGGER USER");
    try {
      await w.client.query("UPDATE offering.subscriptions SET state = 'payment_pending' WHERE id = $1", [a.sub]);
    } finally {
      await w.client.query("ALTER TABLE offering.subscriptions ENABLE TRIGGER USER");
    }
    const fs = await run(o);
    expect(fs.map((x) => x.check)).toEqual(expect.arrayContaining(["offering.state_mismatch", "offering.escrow_mismatch"]));
  }, 120_000);

  // Last: ageing journals by hand breaks the ledger hash chain for the rest of this database.
  it("before, during and after a funded offering: no false blocking finding; an overdue mint window blocks", async () => {
    const o = await liveOffering(w, { cap: 100n, maxUnits: 60n });
    const a = await paid(o, 60n);
    const b = await paid(o, 40n);
    // Payments are hours old: an open offering's paid subscriptions are allocations, not findings.
    await agePayments(120);
    const live = await run(o);
    // Ageing journals by hand is itself caught by the ledger hash chain: ignore exactly that.
    expect(blocking(live).filter((x) => !x.startsWith("integrity.ledger_chain"))).toEqual([]);
    expect(live.map((x) => x.check)).not.toContain("issuance.paid_not_minted");

    // Funded and completing, mint window opened just now: still in flight.
    await ageClose(w, o.id);
    const t = await w.of("tick", { offeringId: o.id, actor: OF.system });
    await w.of("decide", { requestId: String(t.proposed), officer: OF.trustee, approve: true, reason: "paid units confirmed with the bank" });
    await w.of("prepareBatch", { offeringId: o.id, actor: OF.maker, reason: "issuance batch from the allocations" });
    await w.of("decideAll", { offeringId: o.id, code: "IB", officer: OF.checker, approve: true, reason: "batch checked against allocations" });
    await w.of("decideAll", { offeringId: o.id, code: "IB", officer: OF.trustee, approve: true, reason: "batch checked against the register" });
    const conditions = Object.fromEntries(["encumbrances_discharged", "sale_deed_ready", "approvals_consents", "insurance", "trust_deed_executed", "register_ready"].map((k) => [k, hex32()]));
    const l13 = await w.of("request", { offeringId: o.id, code: "L13", actor: OF.maker, reason: "all conditions precedent evidenced", detail: { conditions } });
    await w.of("decide", { requestId: l13, officer: OF.checker2, approve: true, reason: "conditions evidence reviewed" });
    await w.of("decide", { requestId: l13, officer: OF.trustee, approve: true, reason: "trustee agrees to complete" });
    const funded = await run(o);
    expect(funded.map((x) => x.check)).not.toContain("issuance.paid_not_minted");
    const cmp = await w.of("request", {
      offeringId: o.id,
      code: "CMP",
      actor: OF.maker,
      reason: "sale deed registered, seller paid",
      detail: { deedSha: hex32(), deedRegistration: "Sub-Registrar Cantt 99/2026", batchReference: "PTCMP-0099", batchFileSha: hex32() },
    });
    await w.of("decide", { requestId: cmp, officer: OF.trustee, approve: true, reason: "deed and payments verified" });
    await w.of("startMinting", { offeringId: o.id, actor: OF.system });
    expect((await run(o)).map((x) => x.check)).not.toContain("issuance.paid_not_minted");

    // The mint window has been open longer than the SLA without a mint: blocking.
    await ageMintWindow(o, 45);
    const overdue = await run(o);
    expect(overdue.filter((x) => x.check === "issuance.paid_not_minted")).toHaveLength(2);
    expect(overdue.find((x) => x.check === "issuance.paid_not_minted")?.actual).toMatch(/mint window opened/);

    // Mints arrive and settle: clean again apart from the hand-aged journals.
    const refOf = async (id: string): Promise<string> => (await w.client.query<{ ref_id: string }>("SELECT ref_id FROM offering.subscriptions WHERE id = $1", [id])).rows[0]?.ref_id ?? "";
    await mintOnChain(w, o.d, await refOf(a.sub), a.inv.wallet, 60n);
    await mintOnChain(w, o.d, await refOf(b.sub), b.inv.wallet, 40n);
    await w.of("settle", { offeringId: o.id, actor: OF.system });
    const l14 = await w.of("request", { offeringId: o.id, code: "L14", actor: OF.maker, reason: "register attested by the trustee", detail: { registerSha: hex32(), totalUnits: "100" } });
    await w.of("decide", { requestId: l14, officer: OF.trustee, approve: true, reason: "register entries confirmed" });
    const after = await run(o);
    expect(blocking(after).filter((x) => !x.startsWith("integrity.ledger_chain"))).toEqual([]);
    expect(after.filter((x) => x.check.startsWith("offering."))).toEqual([]);
  }, 240_000);
});
