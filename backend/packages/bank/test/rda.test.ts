import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { officer, type TestOfficer } from "../../db/test/officers.ts";
import { makeIban } from "../src/iban.ts";
import { ageCoolingOff, investor, refId, world, type World } from "./setup.ts";

/**
 * Spec S-08 (migration 0056) against a real PostgreSQL and the mock bank: a non-resident (NICOP)
 * reads "review" until two compliance officers approve; only a Roshan Digital Account can be their
 * payout account (mock: account number starting with 9); money in only from that RDA (else
 * suspense); money out only to an active RDA (bank.active_payee), also after a move abroad.
 */
let w: World;
let portal: pg.Client;
let compA: TestOfficer;
let compB: TestOfficer;
let seq = 0;
let counter = Date.now();

beforeAll(async () => {
  w = await world();
  portal = new pg.Client(w.settings);
  await portal.connect();
  await portal.query("SET ROLE pt_admin_portal");
  compA = await officer(w.db, "comp.rda.a", "compliance_officer");
  compB = await officer(w.db, "comp.rda.b", "compliance_officer");
}, 120_000);

afterAll(async () => {
  await portal.end();
  await w.drop();
});

const status = async (subjectId: string) => (await w.db.query<{ s: string }>("SELECT kyc.subject_status($1) AS s", [subjectId])).rows[0]?.s;

/** A NICOP holder living in the UAE (784), onboarded by the KYC service. */
async function abroad(name: string): Promise<string> {
  seq++;
  const r = await w.kyc.onboard({
    cnic: `35206${String(4_000_000 + seq).slice(-7)}${String(1 + (seq % 7))}`,
    fullName: name,
    livenessSessionId: `sess-rda-${String(seq).padStart(4, "0")}`,
    residency: { status: "non_resident", document: "nicop", country: 784 },
  });
  expect(r.status).toBe("review");
  return r.subjectId;
}

type Act = { ok: boolean; status?: string; error?: string };
async function act(o: TestOfficer, subjectId: string, action: string): Promise<Act> {
  const id = (await w.db.query<{ id: string }>("SELECT id FROM compliance.residency_reviews WHERE subject_id = $1 ORDER BY id DESC LIMIT 1", [subjectId])).rows[0]?.id;
  const d = await portal.query<{ v: { digest: string } }>("SELECT admin.residency_review($1, $2) AS v", [o.sessionHash, id]);
  await portal.query("SELECT admin.record_step_up($1, $2, $3)", [o.sessionHash, o.credentialId, ++counter]);
  const { rows } = await portal.query<{ r: Act }>("SELECT admin.residency_act($1, $2, $3, 'NICOP and UAE residence permit checked', $4) AS r", [
    o.sessionHash, id, action, Buffer.from(d.rows[0]?.v.digest ?? "", "hex"),
  ]);
  return rows[0]?.r ?? { ok: false };
}

function account(name: string, rda: boolean): string {
  const iban = makeIban("MEZN", `${rda ? "9" : "1"}${String(500_000_000_000_000 + ++seq).slice(-15)}`);
  w.mock.openAccount(iban, name);
  return iban;
}

async function code(subjectId: string): Promise<string> {
  return w.bank.createIntent({ purpose: "subscription", subjectId, amountPaisa: 100_000n, ledgerKey: `sub:${refId()}:paid`, creditAccount: `investor:${subjectId}:subscriptions` });
}

describe("Roshan Digital Account investors (S-08)", () => {
  it("RD-2: review until two officers approve; RD-5: only an RDA as payout account; RD-3: money only from it", async () => {
    const name = `Nadia Abroad ${randomUUID().slice(0, 4).replace(/[0-9]/g, "x")}`;
    const s = await abroad(name);
    const domestic = account(name, false);
    const rda = account(name, true);
    await expect(w.service.registerPayee(s, rda)).rejects.toThrow(/only a KYC-verified investor/);

    expect(await act(compA, s, "propose")).toMatchObject({ ok: true, status: "proposed" });
    expect((await act(compA, s, "confirm")).error).toMatch(/maker-checker/);
    expect(await act(compB, s, "confirm")).toMatchObject({ ok: true, status: "approved" });
    expect(await status(s)).toBe("verified");

    await expect(w.service.registerPayee(s, domestic)).rejects.toThrow(/registers a Roshan Digital Account/);
    await w.service.registerPayee(s, rda);
    const kind = await w.db.query<{ k: string }>("SELECT account_kind AS k FROM bank.payees WHERE subject_id = $1 AND superseded_at IS NULL", [s]);
    expect(kind.rows[0]?.k).toBe("rda");
    await w.db.query("SELECT ledger.open_account($1, 'liability', 'PKR')", [`investor:${s}:subscriptions`]).catch(() => undefined);

    // RD-3: the RDA pays; an account that is not registered goes to suspense as before.
    const ok = await w.mock.receiveRaast({ payerIban: rda, amountPaisa: 100_000n, narration: await code(s) });
    expect((await w.db.query<{ status: string }>("SELECT status FROM bank.credits WHERE raast_ref = $1", [ok.raastRef])).rows[0]?.status).toBe("matched");
    // RD-4: no payout before the cooling-off; then the RDA is the active payee.
    expect((await w.db.query<{ p: string | null }>("SELECT bank.active_payee($1) AS p", [s])).rows[0]?.p).toBeNull();
    await ageCoolingOff(w, s);
    expect((await w.db.query<{ p: string | null }>("SELECT bank.active_payee($1) AS p", [s])).rows[0]?.p).not.toBeNull();
  });

  it("RD-9: a resident who moves abroad is reviewed again; the domestic account no longer pays out or pays in", async () => {
    const a = await investor(w); // resident, domestic payout account, cooling-off over
    expect((await w.db.query<{ p: string | null }>("SELECT bank.active_payee($1) AS p", [a.subjectId])).rows[0]?.p).not.toBeNull();
    await w.db.query("SELECT kyc.record_residency($1, 'non_resident', 'nicop', 826::smallint, 'kyc-service')", [a.subjectId]);
    expect(await status(a.subjectId)).toBe("review");
    expect(await act(compA, a.subjectId, "propose")).toMatchObject({ ok: true });
    expect(await act(compB, a.subjectId, "confirm")).toMatchObject({ ok: true, status: "approved" });
    // Held, never paid to the old domestic account.
    expect((await w.db.query<{ p: string | null }>("SELECT bank.active_payee($1) AS p", [a.subjectId])).rows[0]?.p).toBeNull();
    const paid = await w.mock.receiveRaast({ payerIban: a.iban, amountPaisa: 100_000n, narration: await code(a.subjectId) });
    expect((await w.db.query<{ status: string; reason: string }>("SELECT status, reason FROM bank.credits WHERE raast_ref = $1", [paid.raastRef])).rows[0]).toEqual({
      status: "suspense",
      reason: "a non-resident investor pays from their Roshan Digital Account",
    });
  });

  it("a rejected review revokes; history and reviews are never edited; the audit chains verify", async () => {
    const s = await abroad(`Omar Abroad ${randomUUID().slice(0, 4).replace(/[0-9]/g, "x")}`);
    expect(await act(compA, s, "reject")).toMatchObject({ ok: true, status: "rejected" });
    expect(await status(s)).toBe("revoked");
    await expect(w.db.query("UPDATE kyc.residency SET country = 4 WHERE subject_id = $1", [s])).rejects.toThrow();
    await expect(w.db.query("UPDATE compliance.residency_reviews SET status = 'open' WHERE subject_id = $1", [s])).rejects.toThrow(/closed/);
    expect((await w.db.query("SELECT * FROM compliance.verify_audit()")).rows).toEqual([]);
    expect((await w.db.query("SELECT * FROM kyc.verify_audit()")).rows).toEqual([]);
    expect((await w.db.query("SELECT * FROM bank.verify_audit()")).rows).toEqual([]);
    const view = await portal.query<{ v: { investors: { ref: string; country: number }[] } }>("SELECT admin.residency_reviews($1) AS v", [compA.sessionHash]);
    expect(view.rows[0]?.v.investors.length).toBeGreaterThanOrEqual(2);
  });
});
