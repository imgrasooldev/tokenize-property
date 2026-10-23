import { randomBytes, randomUUID } from "node:crypto";
import { revoke } from "@pt/kyc";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decidePayoutBatch } from "../../bank/src/service.ts";
import { ageCoolingOff, finalizedDistribution, freezeRecon, investor, newAccount, passRecon, rentOwed, token, world, type World } from "../../bank/test/setup.ts";
import { officer } from "../../db/test/officers.ts";
import { sweep, verifyAudit } from "../src/service.ts";
import { kindsOf, notesOf, producerFailureCount } from "./helpers.ts";

/**
 * Migration 0030 producers of the bank (payout accounts, unmatched credits, rent payouts, held and
 * returned lines), reconciliation (payout pause, release requests: officers only) and the signing
 * service's approvals queue, on the bank test world.
 */

let w: World;
const OPS_MAKER = "ops.maker.np";
const OPS_CHECKER = "ops.checker.np";
const TRUSTEE = "trustee.np";
const COMPLIANCE = "comp.np";

beforeAll(async () => {
  w = await world();
  await officer(w.db, OPS_MAKER, "ops_maker");
  await officer(w.db, OPS_CHECKER, "ops_checker");
  await officer(w.db, TRUSTEE, "trustee_officer");
  await officer(w.db, COMPLIANCE, "compliance_officer");
}, 180_000);
afterAll(async () => {
  await w.drop();
}, 120_000);

const count = async (subject: string, kind: string): Promise<number> => (await notesOf(w.pool, "investor", subject, kind)).length;

describe("bank producers", () => {
  it("payout account: added once, changed with the previous last four digits, active once after the cooling-off however often the sweep runs", async () => {
    const a = await investor(w, "Payee Alpha", { active: false });
    const added = await notesOf(w.pool, "investor", a.subjectId, "security.payout_account_added");
    expect(added).toHaveLength(1);
    const first = added[0]?.params.last4 ?? "";
    await w.bank.registerPayee(a.subjectId, newAccount(w, "Payee Alpha"));
    const changed = await notesOf(w.pool, "investor", a.subjectId, "security.payout_account_changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]?.params.previous_last4).toBe(first);
    expect(changed[0]?.params.last4).not.toBe(first);
    expect(await count(a.subjectId, "security.payout_account_active")).toBe(0);
    await sweep(w.pool);
    expect(await count(a.subjectId, "security.payout_account_active")).toBe(0);
    await ageCoolingOff(w, a.subjectId);
    await sweep(w.pool);
    await sweep(w.pool);
    expect(await count(a.subjectId, "security.payout_account_active")).toBe(1);
  });

  it("an unmatched credit tells the investor generically, once; never when the investor is not verified (NP-4)", async () => {
    const a = await investor(w, "Credit Alpha");
    const ref = `0x${randomBytes(32).toString("hex")}`;
    const code = await w.bank.createIntent({ purpose: "subscription", subjectId: a.subjectId, amountPaisa: 50_000n, ledgerKey: `sub:${ref}:paid`, creditAccount: `investor:${a.subjectId}:subscriptions` });
    const r = await w.mock.receiveRaast({ payerIban: a.iban, amountPaisa: 49_999n, narration: `Subscription ${code}` });
    expect(await count(a.subjectId, "bank.payment_unmatched")).toBe(1);
    // The bank re-sends the same event: booked once, told once.
    expect(r.event?.status).toBe(200);
    await w.mock.redeliver(r.event?.id ?? "");
    expect(await count(a.subjectId, "bank.payment_unmatched")).toBe(1);

    const b = await investor(w, "Credit Bravo");
    const refB = `0x${randomBytes(32).toString("hex")}`;
    const codeB = await w.bank.createIntent({ purpose: "subscription", subjectId: b.subjectId, amountPaisa: 70_000n, ledgerKey: `sub:${refB}:paid`, creditAccount: `investor:${b.subjectId}:subscriptions` });
    const before = await kindsOf(w.pool, b.subjectId);
    await revoke(w.db, b.subjectId, "officer:amna", "Sanctions list update, under investigation");
    await w.mock.receiveRaast({ payerIban: b.iban, amountPaisa: 70_000n, narration: `Subscription ${codeB}` });
    // Revoked: no KYC notice and no payment notice (the reason must not leak).
    expect(await kindsOf(w.pool, b.subjectId)).toEqual(before);
  });

  it("a payout batch: rent paid per paid line, held line told to add an account, nothing for a revoked investor; returned payout told once", async () => {
    const t = token();
    const ready = await investor(w, "Rent Ready");
    const closing = await investor(w, "Rent Closing");
    const cooling = await investor(w, "Rent Cooling", { active: false });
    const revoked = await investor(w, "Rent Revoked");
    const owed = [
      { subjectId: ready.subjectId, amountPaisa: 5_000n },
      { subjectId: closing.subjectId, amountPaisa: 4_000n },
      { subjectId: cooling.subjectId, amountPaisa: 3_000n },
      { subjectId: revoked.subjectId, amountPaisa: 2_000n },
    ];
    await rentOwed(w, t, 1n, owed);
    await revoke(w.db, revoked.subjectId, "officer:amna", "Sanctions list update, under investigation");
    const revokedBefore = await kindsOf(w.pool, revoked.subjectId);
    await finalizedDistribution(w, t, 1n, 14_000n);
    await passRecon(w);
    const batch = await w.bank.createPayoutBatch({ token: t, distributionId: 1n, items: owed, createdBy: "operator:maker" });
    expect(await count(ready.subjectId, "rent.paid")).toBe(0);
    await decidePayoutBatch(w.db, batch, "operator:checker", "approve", "Held lines checked, rest is correct");
    w.mock.closeAccount(closing.iban);
    await w.bank.submitPayoutBatch(batch, w.mock);
    // A crash after recording: submitting again books and tells nothing new.
    await w.bank.submitPayoutBatch(batch, w.mock);
    const paid = await notesOf(w.pool, "investor", ready.subjectId, "rent.paid");
    expect(paid).toHaveLength(1);
    expect(paid[0]?.params).toEqual({ token: `PT-${t.slice(2, 8).toUpperCase()}`, amount_paisa: "5000", period: "D-1" });
    expect(await count(closing.subjectId, "rent.paid")).toBe(1);
    expect(await count(cooling.subjectId, "rent.paid")).toBe(0);
    expect(await count(cooling.subjectId, "rent.held")).toBe(1);
    expect(await kindsOf(w.pool, revoked.subjectId)).toEqual(revokedBefore);

    await w.mock.processReturns();
    await w.mock.processReturns();
    const returned = await notesOf(w.pool, "investor", closing.subjectId, "rent.payout_returned");
    expect(returned).toHaveLength(1);
    expect(returned[0]?.params.amount_paisa).toBe("4000");
  });
});

describe("reconciliation and signing approvals (officers only)", () => {
  it("a payout pause alerts operations and the trustee once; a release request waits for the other checker", async () => {
    const investorsBefore = Number((await w.db.query<{ n: string }>("SELECT count(*) AS n FROM notify.recipients WHERE subject_type = 'investor'")).rows[0]?.n);
    await freezeRecon(w);
    const { rows } = await w.db.query<{ id: string }>("SELECT id::text FROM recon.gate_events WHERE action = 'freeze' ORDER BY id DESC LIMIT 1");
    const ev = rows[0]?.id ?? "";
    const alerts = async (h: string) => (await notesOf(w.pool, "officer", h, "officer.alert")).filter((n) => n.key.startsWith(`recon:gate:${ev}:`));
    for (const h of [OPS_MAKER, OPS_CHECKER, TRUSTEE]) {
      const a = await alerts(h);
      expect(a, h).toHaveLength(1);
      expect(a[0]?.params.topic).toBe("payouts_paused");
      expect(a[0]?.category).toBe("security");
    }
    expect(await alerts(COMPLIANCE)).toHaveLength(0);
    // Officers only: no investor recipient was created.
    expect(Number((await w.db.query<{ n: string }>("SELECT count(*) AS n FROM notify.recipients WHERE subject_type = 'investor'")).rows[0]?.n)).toBe(investorsBefore);

    const { rows: req } = await w.db.query<{ id: string }>("SELECT recon.request_unfreeze('operator:ali', 'cash difference explained by a bank fee')::text AS id");
    const waiting = async (h: string) => (await notesOf(w.pool, "officer", h, "officer.action_waiting")).filter((n) => n.key.startsWith(`recon:unfreeze:${req[0]?.id ?? ""}:`));
    expect(await waiting(OPS_CHECKER)).toHaveLength(1);
    // Only checkers decide a release.
    expect(await waiting(OPS_MAKER)).toHaveLength(0);
    expect(await waiting(TRUSTEE)).toHaveLength(0);
    await passRecon(w);
  });

  it("a signing request waiting for approval reaches the platform checkers, and the trustee when it needs a co-signature; not the requester", async () => {
    await w.db.query("INSERT INTO signer.keys (key_ref, address, purpose) VALUES ('issuer_np', $1, 'test key for notify producers') ON CONFLICT DO NOTHING", [
      `0x${randomBytes(20).toString("hex")}`,
    ]);
    const insert = async (kind: string, status: string, approvals: number): Promise<string> => {
      const { rows } = await w.db.query<{ id: string }>(
        `INSERT INTO signer.requests (command_ref, kind, key_ref, payload, payload_hash, amount, requested_by, status, approvals_needed)
         VALUES ($1, $2, 'issuer_np', '{}', $3, 1000, $4, $5, $6) RETURNING id::text`,
        [`np:${randomUUID()}`, kind, randomBytes(32), OPS_CHECKER, status, approvals],
      );
      return rows[0]?.id ?? "";
    };
    const mint = await insert("issuance.mint", "pending_approval", 2);
    const forReq = async (h: string, id: string) => (await notesOf(w.pool, "officer", h, "officer.action_waiting")).filter((n) => n.key.startsWith(`signer:request:${id}:`));
    expect(await forReq(OPS_CHECKER, mint)).toHaveLength(0);
    expect((await forReq(TRUSTEE, mint)).map((n) => n.params.queue)).toEqual(["trustee_cosign"]);
    const other = await insert("token.transfer", "pending_approval", 1);
    expect(await forReq(TRUSTEE, other)).toHaveLength(0);
    // Requested by someone else: the checker is told.
    const { rows } = await w.db.query<{ id: string }>(
      `INSERT INTO signer.requests (command_ref, kind, key_ref, payload, payload_hash, amount, requested_by, status, approvals_needed)
       VALUES ($1, 'token.transfer', 'issuer_np', '{}', $2, 1000, 'outbox-worker', 'pending_approval', 1) RETURNING id::text`,
      [`np:${randomUUID()}`, randomBytes(32)],
    );
    expect((await forReq(OPS_CHECKER, rows[0]?.id ?? "")).map((n) => n.params.queue)).toEqual(["signing"]);
    // A request signed straight away (below the threshold) waits for nobody.
    const signed = await insert("token.transfer", "approved", 0);
    expect(await forReq(OPS_CHECKER, signed)).toHaveLength(0);
  });

  it("no producer failed and the notify audit chain verifies", async () => {
    expect(await producerFailureCount(w.pool)).toBe(0);
    expect(await verifyAudit(w.pool)).toEqual([]);
  });
});
