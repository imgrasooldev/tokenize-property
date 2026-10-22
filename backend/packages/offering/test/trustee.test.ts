import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { officer, type TestOfficer } from "../../db/test/officers.ts";
import { OfferingError } from "../src/service.ts";
import { accept, ageClose, hex32, investor, liveOffering, makeWorld, mintOnChain, OF, offeringState, pay, reserve, subState, type Offering, type World } from "./world.ts";

/**
 * Step 6d (migration 0023): the trustee's S-02 votes given in the trustee portal. For a portal
 * officer the trustee duty is the trustee_officer role; votes run offering.decide under the
 * officer's handle after the session, permission, step-up and digest checks; the handle is refused
 * on the command line; the trustee's register follows V18 by itself.
 */
let w: World;
let t1: TestOfficer;
let t2: TestOfficer;
let ops: TestOfficer;

beforeAll(async () => {
  w = await makeWorld();
  t1 = await officer(w.client, "trustee.portal.one", "trustee_officer");
  t2 = await officer(w.client, "trustee.portal.two", "trustee_officer");
  ops = await officer(w.client, "ops.portal.checker", "ops_checker");
}, 180_000);
afterAll(async () => {
  await w.drop();
}, 120_000);

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof OfferingError) return e.code;
    return (e as { code?: string }).code ?? "ERROR";
  }
  return "OK";
};

async function digest(req: string | bigint): Promise<Buffer> {
  return (await w.client.query<{ d: Buffer }>("SELECT admin.offering_request_digest($1) AS d", [String(req)])).rows[0]?.d ?? Buffer.alloc(32);
}

async function vote(o: TestOfficer, req: string | bigint, decision: "approve" | "reject", reason: string, d?: Buffer): Promise<{ ok: boolean; status?: string; error?: string }> {
  const { rows } = await w.client.query<{ r: { ok: boolean; status?: string; error?: string } }>("SELECT admin.decide_offering_request($1, $2, $3, $4, $5) AS r", [
    o.sessionHash,
    String(req),
    decision,
    reason,
    d ?? (await digest(req)),
  ]);
  return rows[0]?.r ?? { ok: false };
}

async function paid(o: Offering, units: bigint): Promise<{ sub: string; wallet: string }> {
  const inv = await investor(w, o.d);
  await accept(w, o.id, inv, o.docs);
  const r = await reserve(w, o.id, inv, units);
  await pay(w, inv, r.paymentCode, BigInt(r.amountPaisa));
  return { sub: r.subscriptionId, wallet: inv.wallet };
}

describe("trustee votes on S-02 requests through the portal (migration 0023)", () => {
  it("funding, issuance batch, completion and the register are confirmed by portal trustee officers; the register follows the chain", async () => {
    const o = await liveOffering(w, { cap: 100n, maxUnits: 60n });
    const a = await paid(o, 60n);
    const b = await paid(o, 40n);
    await ageClose(w, o.id);
    const t = await w.of("tick", { offeringId: o.id, actor: OF.system });
    const l11 = String(t.proposed);
    // The officer's handle cannot be used on the command line.
    expect(await code(w.of("decide", { requestId: l11, officer: t1.handle, approve: true, reason: "pretending to be the portal" }))).toBe("FORBIDDEN");
    // An operations officer has no trustee permission.
    expect(await code(vote(ops, l11, "approve", "operations is not the trustee"))).toBe("42501");
    // What the officer reviewed must still be the request.
    expect(await vote(t1, l11, "approve", "paid units confirmed with the bank", Buffer.alloc(32, 1))).toMatchObject({ ok: false, error: expect.stringMatching(/differs/) as unknown });
    expect(await vote(t1, l11, "approve", "paid units confirmed with the bank")).toEqual({ ok: true, status: "approved" });
    expect(await offeringState(w, o.id)).toBe("funded");

    // OF-46 issuance batch: offering checker (command line duty) and the trustee (portal).
    await w.of("prepareBatch", { offeringId: o.id, actor: OF.maker, reason: "issuance batch from the allocations" });
    const ib = (await w.client.query<{ id: string }>("SELECT id FROM offering.requests WHERE offering_id = $1 AND code = 'IB' AND status = 'open'", [o.id])).rows[0]?.id ?? "";
    const view = (await w.client.query<{ v: { batch: { items: number; matchesAllocations: boolean }; blockers: string[]; needs: string[] } }>("SELECT admin.trustee_offering_request($1, $2) AS v", [t1.sessionHash, ib])).rows[0]?.v;
    expect(view).toMatchObject({ batch: { items: 2, matchesAllocations: true }, blockers: [], needs: ["offering", "trustee"] });
    expect(await vote(t1, ib, "approve", "batch checked against the register")).toEqual({ ok: true, status: "open" });
    // The trustee vote is recorded once; a second trustee officer adds nothing.
    expect(await vote(t2, ib, "approve", "batch checked again by the second trustee officer")).toMatchObject({ ok: false, error: expect.stringMatching(/already recorded/) as unknown });
    expect(await w.of("decide", { requestId: ib, officer: OF.checker, approve: true, reason: "batch checked against allocations" })).toBe("approved");

    const conditions = Object.fromEntries(["encumbrances_discharged", "sale_deed_ready", "approvals_consents", "insurance", "trust_deed_executed", "register_ready"].map((k) => [k, hex32()]));
    const l13 = await w.of("request", { offeringId: o.id, code: "L13", actor: OF.maker, reason: "all conditions precedent evidenced", detail: { conditions } });
    await w.of("decide", { requestId: l13, officer: OF.checker2, approve: true, reason: "conditions evidence reviewed" });
    expect(await vote(t2, l13, "approve", "trustee agrees to complete")).toEqual({ ok: true, status: "approved" });
    // OF-45: completion record (registered sale deed + completion payment batch file) by the trustee alone.
    const cmp = await w.of("request", {
      offeringId: o.id,
      code: "CMP",
      actor: OF.maker,
      reason: "sale deed registered, seller paid",
      detail: { deedSha: hex32(), deedRegistration: "Sub-Registrar Cantt 4321/2026", batchReference: "PTCMP-0042", batchFileSha: hex32() },
    });
    expect(await vote(t1, cmp, "approve", "deed and completion payments verified")).toEqual({ ok: true, status: "approved" });
    expect(await w.of("startMinting", { offeringId: o.id, actor: OF.system })).toBe(2);

    for (const [x, units] of [[a, 60n], [b, 40n]] as const) {
      const ref = (await w.client.query<{ ref_id: string }>("SELECT ref_id FROM offering.subscriptions WHERE id = $1", [x.sub])).rows[0]?.ref_id ?? "";
      await mintOnChain(w, o.d, ref, x.wallet, units);
    }
    await w.of("settle", { offeringId: o.id, actor: OF.system });
    const l14 = await w.of("request", { offeringId: o.id, code: "L14", actor: OF.maker, reason: "register attested by the trustee", detail: { registerSha: hex32(), totalUnits: "100" } });
    expect(await vote(t2, l14, "approve", "register entries confirmed")).toEqual({ ok: true, status: "approved" });
    expect(await offeringState(w, o.id)).toBe("completed");
    expect(await subState(w, a.sub)).toBe("active");

    // V18 wrote the trustee's register; it equals the read model at the pinned block.
    const reg = (await w.client.query<{ v: { registerTotal: string; supply: string; differences: number; lines: { wallet: string; register: string; chain: string }[] } }>(
      "SELECT admin.trustee_register($1, $2, 100) AS v",
      [t1.sessionHash, o.d.token],
    )).rows[0]?.v;
    expect(reg).toMatchObject({ registerTotal: "100", supply: "100", differences: 0 });
    expect(reg?.lines.map((l) => [l.wallet, l.register, l.chain]).sort()).toEqual([[a.wallet, "60", "60"], [b.wallet, "40", "40"]].sort());

    for (const chain of ["trustee", "offering", "admin"]) {
      expect((await w.client.query(`SELECT * FROM ${chain}.verify_audit()`)).rows, chain).toEqual([]);
    }
    const audit = await w.client.query<{ action: string }>("SELECT action FROM trustee.audit ORDER BY id");
    expect(audit.rows.filter((r) => r.action === "cosign.offering")).toHaveLength(5);
    expect(audit.rows.filter((r) => r.action === "register.entered")).toHaveLength(2);
  }, 240_000);

  it("a trustee officer holds no other offering duty and only trustee officers hold the trustee duty (OF-SOD-4)", async () => {
    expect(await code(w.of("requestDuty", { actor: t1.handle, duty: "offering", by: OF.admin1, reason: "assigned by the operations head" }))).toBe("FORBIDDEN");
    expect(await code(w.of("requestDuty", { actor: ops.handle, duty: "trustee", by: OF.admin1, reason: "assigned by the operations head" }))).toBe("FORBIDDEN");
  });
});
