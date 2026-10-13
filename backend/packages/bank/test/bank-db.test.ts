import { balanceOf } from "@pt/ledger";
import { revoke } from "@pt/kyc";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BankError, BankService, decidePayoutBatch, verifyAudit } from "../src/service.ts";
import {
  ageCoolingOff,
  cashFindings,
  ESCROW,
  ESCROW_LEDGER,
  escrowBalance,
  finalizedDistribution,
  freezeRecon,
  investor,
  newAccount,
  passRecon,
  refId,
  rentOwed,
  token,
  world,
  type World,
} from "./setup.ts";

/** Step 5g bank (migration 0009, ADR 0009): B-1..B-7 against a real PostgreSQL and the mock bank. */

let w: World;

beforeAll(async () => {
  w = await world();
});

afterAll(async () => {
  await w.drop();
});

async function subscriptionCode(subjectId: string, amount: bigint, ttlMinutes?: number): Promise<{ code: string; key: string }> {
  const key = `sub:${refId()}:paid`;
  const code = await w.bank.createIntent({
    purpose: "subscription",
    subjectId,
    amountPaisa: amount,
    ledgerKey: key,
    creditAccount: `investor:${subjectId}:subscriptions`,
    ...(ttlMinutes === undefined ? {} : { ttlMinutes }),
  });
  return { code, key };
}

async function credit(raastRef: string): Promise<{ status: string; reason: string; journal_id: string } | undefined> {
  const { rows } = await w.db.query<{ status: string; reason: string; journal_id: string }>("SELECT status, reason, journal_id FROM bank.credits WHERE raast_ref = $1", [raastRef]);
  return rows[0];
}

async function journal(key: string): Promise<{ id: string; external_ref: string } | undefined> {
  const { rows } = await w.db.query<{ id: string; external_ref: string }>("SELECT id, external_ref FROM ledger.journal WHERE idempotency_key = $1", [key]);
  return rows[0];
}

describe("Raast credits (B-1, B-2, B-3)", () => {
  it("an exact payment from the investor's own account is matched and booked with the Raast reference", async () => {
    const a = await investor(w);
    const { code, key } = await subscriptionCode(a.subjectId, 250_000n);
    const paid = await w.mock.receiveRaast({ payerIban: a.iban, amountPaisa: 250_000n, narration: `Subscription ${code} GPF3` });
    expect(paid.event?.status).toBe(200);
    expect(await credit(paid.raastRef)).toMatchObject({ status: "matched", reason: `matched ${code}` });
    expect(await journal(key)).toMatchObject({ external_ref: paid.raastRef });
    expect(await balanceOf(w.db, `investor:${a.subjectId}:subscriptions`)).toBe(-250_000n);
    expect(await escrowBalance(w)).toBe(w.mock.balancePaisa);
  });

  it.each([
    ["a different amount", { amount: 249_999n }, "amount differs from the payment code"],
    ["no payment code in the narration", { narration: "rent for october" }, "no valid payment code"],
    ["someone else's account", { thirdParty: true }, "paid from an account not registered to the investor"],
  ])("%s goes to suspense, never to the investor", async (_n, o: { amount?: bigint; narration?: string; thirdParty?: boolean }, reason) => {
    const a = await investor(w);
    const { code } = await subscriptionCode(a.subjectId, 250_000n);
    const payer = o.thirdParty ? newAccount(w, "Unrelated Payer") : a.iban;
    const paid = await w.mock.receiveRaast({ payerIban: payer, amountPaisa: o.amount ?? 250_000n, narration: o.narration ?? code });
    expect(await credit(paid.raastRef)).toMatchObject({ status: "suspense", reason });
    expect(await balanceOf(w.db, `investor:${a.subjectId}:subscriptions`)).toBe(0n);
    expect(await escrowBalance(w)).toBe(w.mock.balancePaisa);
  });

  it("a payment code is paid once; an expired code is not paid at all", async () => {
    const a = await investor(w);
    const { code } = await subscriptionCode(a.subjectId, 10_000n);
    const first = await w.mock.receiveRaast({ payerIban: a.iban, amountPaisa: 10_000n, narration: code });
    const second = await w.mock.receiveRaast({ payerIban: a.iban, amountPaisa: 10_000n, narration: code });
    expect((await credit(first.raastRef))?.status).toBe("matched");
    expect(await credit(second.raastRef)).toMatchObject({ status: "suspense", reason: "payment code already paid" });

    const late = await subscriptionCode(a.subjectId, 10_000n, 5);
    await w.db.query("ALTER TABLE bank.payment_intents DISABLE TRIGGER payment_intents_append_only");
    await w.db.query("UPDATE bank.payment_intents SET created_at = created_at - interval '1 hour', expires_at = expires_at - interval '1 hour' WHERE code = $1", [late.code]);
    await w.db.query("ALTER TABLE bank.payment_intents ENABLE TRIGGER payment_intents_append_only");
    const expired = await w.mock.receiveRaast({ payerIban: a.iban, amountPaisa: 10_000n, narration: late.code });
    expect(await credit(expired.raastRef)).toMatchObject({ status: "suspense", reason: "payment code expired" });
  });

  it("only a verified investor gets a subscription payment code", async () => {
    const a = await investor(w);
    await revoke(w.db, a.subjectId, "officer:amna", "Investor asked to close the account");
    await expect(subscriptionCode(a.subjectId, 1_000n)).rejects.toThrow(/KYC-verified/);
  });

  it("a replayed event books nothing; the same id with another body is refused and alerts; a re-sent transfer is booked once", async () => {
    const a = await investor(w);
    const { code } = await subscriptionCode(a.subjectId, 7_000n);
    const paid = await w.mock.receiveRaast({ payerIban: a.iban, amountPaisa: 7_000n, narration: code });
    const before = await escrowBalance(w);
    const event = paid.event;
    if (!event) throw new Error("no event");
    expect(await w.mock.redeliver(event.id)).toBe(200);
    expect(await w.bank.handle(event.rawBody, "k1")).toEqual({ status: 200, body: { status: "duplicate", outcome: "matched" } });

    const listener = await w.pool.connect();
    const alerts: string[] = [];
    listener.on("notification", (m) => alerts.push(m.payload ?? ""));
    await listener.query("LISTEN bank_alert");
    try {
      const forged = event.rawBody.replace('"amountPaisa":"7000"', '"amountPaisa":"7000000"');
      expect((await w.bank.handle(forged, "k1")).status).toBe(409);
      const resent = JSON.stringify({ ...(JSON.parse(event.rawBody) as object), id: "evt_resent_000001" });
      expect(await w.bank.handle(resent, "k1")).toEqual({ status: 200, body: { status: "processed", outcome: "duplicate_reference" } });
      await new Promise((r) => setTimeout(r, 50));
      expect(alerts.map((x) => (JSON.parse(x) as { kind: string }).kind)).toEqual(["event_conflict"]);
    } finally {
      await listener.query("UNLISTEN bank_alert");
      listener.release();
    }
    expect(await escrowBalance(w)).toBe(before);
    const { rows } = await w.db.query("SELECT 1 FROM bank.audit WHERE action = 'event.conflict'");
    expect(rows).toHaveLength(1);
  });

  it("ten simultaneous deliveries of one event book it exactly once", async () => {
    const a = await investor(w);
    const { code } = await subscriptionCode(a.subjectId, 3_000n);
    const paid = await w.mock.receiveRaast({ payerIban: a.iban, amountPaisa: 3_000n, narration: code, deliver: false });
    const raw = w.mock.delivered.find((d) => d.id === paid.event?.id)?.rawBody ?? "";
    const results = await Promise.all(Array.from({ length: 10 }, () => w.bank.handle(raw, "k1")));
    const statuses = results.map((r) => (r.body as { status: string }).status);
    expect(statuses.filter((x) => x === "processed")).toHaveLength(1);
    expect(statuses.filter((x) => x === "duplicate")).toHaveLength(9);
    const { rows } = await w.db.query("SELECT 1 FROM bank.credits WHERE raast_ref = $1", [paid.raastRef]);
    expect(rows).toHaveLength(1);
    expect(await escrowBalance(w)).toBe(w.mock.balancePaisa);
  });

  it("a malformed or unsigned event never reaches the ledger", async () => {
    expect((await w.bank.handle("not json", "k1")).status).toBe(400);
    expect((await w.bank.handle('{"id":"evt_x0000001","type":"credit.received"}', "k1")).status).toBe(400);
    // Extra fields are refused too (strict schema).
    const a = await investor(w);
    const { code } = await subscriptionCode(a.subjectId, 1_000n);
    const paid = await w.mock.receiveRaast({ payerIban: a.iban, amountPaisa: 1_000n, narration: code, deliver: false });
    const raw = w.mock.delivered.find((d) => d.id === paid.event?.id)?.rawBody ?? "";
    expect((await w.bank.handle(raw.replace('"narration"', '"credit":"all","narration"'), "k1")).status).toBe(400);
    expect(await credit(paid.raastRef)).toBeUndefined();
    // Until the genuine event arrives, the bank holds money the ledger does not know about.
    const held = await cashFindings(w);
    expect(held).toHaveLength(2);
    expect(held[0]).toMatch(/^cash\.closing_mismatch/);
    expect(held[1]?.startsWith("cash.unmatched_bank_line") && held[1].includes(paid.raastRef)).toBe(true);
    expect((await w.bank.handle(raw, "k1")).status).toBe(200);
    expect(await cashFindings(w)).toEqual([]);
  });

  it("a suspense credit goes back to its sender only while the reconciliation gate is open", async () => {
    const payer = newAccount(w, "Lost Payer");
    const paid = await w.mock.receiveRaast({ payerIban: payer, amountPaisa: 4_200n, narration: "no code" });
    await freezeRecon(w);
    await expect(w.bank.returnCredit(paid.raastRef, "operator:ali", "Unidentified payment, returned to sender", w.mock)).rejects.toThrow(/blocked by reconciliation/);
    await w.db.query("SELECT recon.request_unfreeze('operator:ali', 'Test freeze investigated and resolved')");
    await passRecon(w);
    const { rows } = await w.db.query<{ id: string }>("SELECT id FROM recon.unfreeze_requests WHERE status = 'open'");
    await w.db.query("SELECT recon.decide_unfreeze($1, 'operator:sara', 'approve', 'Checked the investigation notes')", [rows[0]?.id]);
    const j = await w.bank.returnCredit(paid.raastRef, "operator:ali", "Unidentified payment, returned to sender", w.mock);
    expect(await w.bank.returnCredit(paid.raastRef, "operator:ali", "Unidentified payment, returned to sender", w.mock)).toBe(j);
    expect(await escrowBalance(w)).toBe(w.mock.balancePaisa);
    expect(await cashFindings(w)).toEqual([]);
  });
});

describe("payout accounts (B-4)", () => {
  it("the account title must match the verified name, and an unknown account is refused", async () => {
    const a = await investor(w, "Rabia Saleem");
    const other = newAccount(w, "Somebody Different");
    await expect(w.bank.registerPayee(a.subjectId, other)).rejects.toThrow(/title does not match/);
    await expect(w.bank.registerPayee(a.subjectId, "PK36SCBL0000001123456702")).rejects.toSatisfy((e: unknown) => e instanceof BankError);
    const spaced = newAccount(w, "rabia   saleem.");
    const id = await w.bank.registerPayee(a.subjectId, spaced);
    expect(id).toBeGreaterThan(0n);
  });

  it("a change supersedes the old account at once, is usable only after 72 hours, and alerts", async () => {
    const a = await investor(w, "Tahir Change");
    const { rows: before } = await w.db.query<{ p: string | null }>("SELECT bank.active_payee($1) AS p", [a.subjectId]);
    expect(before[0]?.p).not.toBeNull();
    const listener = await w.pool.connect();
    const alerts: string[] = [];
    listener.on("notification", (m) => alerts.push(m.payload ?? ""));
    await listener.query("LISTEN bank_alert");
    try {
      await w.bank.registerPayee(a.subjectId, newAccount(w, "Tahir Change", "HABB"));
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      await listener.query("UNLISTEN bank_alert");
      listener.release();
    }
    expect(alerts.map((x) => (JSON.parse(x) as { kind: string; subject: string }))).toEqual([expect.objectContaining({ kind: "payee_changed", subject: a.subjectId })]);
    const { rows } = await w.db.query<{ p: string | null; hours: number }>(
      "SELECT bank.active_payee($1) AS p, (SELECT extract(epoch FROM active_from - registered_at) / 3600 FROM bank.payees WHERE subject_id = $1 AND superseded_at IS NULL)::int AS hours",
      [a.subjectId],
    );
    expect(rows[0]).toEqual({ p: null, hours: 72 });
  });

  it("one account cannot be the payout account of two investors, and records cannot be edited", async () => {
    const a = await investor(w, "Same Name");
    const b = await investor(w, "Same Name");
    const { rows } = await w.db.query<{ iban_hash: Buffer }>("SELECT iban_hash FROM bank.payees WHERE subject_id = $1 AND superseded_at IS NULL", [a.subjectId]);
    expect(rows[0]).toBeDefined();
    await expect(w.bank.registerPayee(b.subjectId, a.iban)).rejects.toThrow(/another investor/);
    await expect(w.db.query("UPDATE bank.payees SET active_from = now() WHERE subject_id = $1", [b.subjectId])).rejects.toThrow(/superseded/);
    await expect(w.db.query("DELETE FROM bank.payees WHERE subject_id = $1", [b.subjectId])).rejects.toThrow(/never deleted/);
  });
});

describe("payout batches (B-5, B-6)", () => {
  it("full path: maker-checker, gate checked twice, booked with the file hash, sent once, a returned line is owed again", async () => {
    const t = token();
    const a = await investor(w, "Payout Alpha");
    const b = await investor(w, "Payout Bravo");
    await rentOwed(w, t, 1n, [{ subjectId: a.subjectId, amountPaisa: 60_000n }, { subjectId: b.subjectId, amountPaisa: 40_000n }]);
    await finalizedDistribution(w, t, 1n, 100_000n);
    w.mock.closeAccount(b.iban);
    await passRecon(w);

    const items = [{ subjectId: a.subjectId, amountPaisa: 60_000n }, { subjectId: b.subjectId, amountPaisa: 40_000n }];
    const batch = await w.bank.createPayoutBatch({ token: t, distributionId: 1n, items, createdBy: "operator:maker" });
    await expect(w.bank.createPayoutBatch({ token: t, distributionId: 1n, items, createdBy: "operator:maker" })).rejects.toThrow(/already has a payout batch/);
    await expect(w.bank.submitPayoutBatch(batch, w.mock)).rejects.toThrow(/not approved/);
    await expect(decidePayoutBatch(w.db, batch, "operator:maker", "approve", "approving my own batch")).rejects.toThrow(/maker-checker/);
    expect(await decidePayoutBatch(w.db, batch, "operator:checker", "approve", "Totals match the finalized distribution")).toBe("approved");

    const escrowBefore = await escrowBalance(w);
    const sent = await w.bank.submitPayoutBatch(batch, w.mock);
    expect(sent.file).toContain(a.iban);
    expect(sent.file).not.toContain("Payout Alpha");
    const { rows } = await w.db.query<{ status: string; sha: string; key: string; ref: string }>(
      `SELECT b.status, '0x' || encode(b.file_sha256, 'hex') AS sha, j.idempotency_key AS key, j.external_ref AS ref
       FROM bank.payout_batches b JOIN ledger.journal j ON j.id = b.journal_id WHERE b.id = $1`,
      [batch.toString()],
    );
    expect(rows[0]).toMatchObject({ status: "submitted", sha: sent.fileSha256, key: `rent:payout:${t}:1` });
    expect(await escrowBalance(w)).toBe(escrowBefore - 100_000n);
    expect(await balanceOf(w.db, `rent:payable:${a.subjectId}`)).toBe(0n);

    // A crash after recording: submitting again rebuilds the same bytes, books nothing new, the bank ignores the copy.
    const again = await w.bank.submitPayoutBatch(batch, w.mock);
    expect(again).toEqual(sent);
    expect(await escrowBalance(w)).toBe(escrowBefore - 100_000n);
    expect(await escrowBalance(w)).toBe(w.mock.balancePaisa);

    // Bravo's account is closed: the line comes back, Bravo is owed again and has no payout account until they register one.
    const returns = await w.mock.processReturns();
    expect(returns.map((r) => r.status)).toEqual([200]);
    expect(await balanceOf(w.db, `rent:payable:${b.subjectId}`)).toBe(-40_000n);
    const { rows: payee } = await w.db.query<{ p: string | null }>("SELECT bank.active_payee($1) AS p", [b.subjectId]);
    expect(payee[0]?.p).toBeNull();
    expect(await escrowBalance(w)).toBe(w.mock.balancePaisa);
    expect(await cashFindings(w)).toEqual([]);
  });

  it("refuses a batch for a distribution that is not finalized or whose total differs", async () => {
    const t = token();
    const a = await investor(w);
    await finalizedDistribution(w, t, 1n, 5_000n, "published");
    await expect(w.bank.createPayoutBatch({ token: t, distributionId: 1n, items: [{ subjectId: a.subjectId, amountPaisa: 5_000n }], createdBy: "operator:maker" })).rejects.toThrow(/not finalized/);
    await finalizedDistribution(w, t, 2n, 5_000n);
    await expect(w.bank.createPayoutBatch({ token: t, distributionId: 2n, items: [{ subjectId: a.subjectId, amountPaisa: 5_001n }], createdBy: "operator:maker" })).rejects.toThrow(/does not equal the on-chain distribution total/);
    await expect(w.bank.createPayoutBatch({ token: t, distributionId: 3n, items: [{ subjectId: a.subjectId, amountPaisa: 1n }], createdBy: "operator:maker" })).rejects.toThrow(/not found/);
  });

  it("held payouts (ADR 0009 decision 2): investors who cannot be paid now are held, the rest is paid, a follow-up pays them later", async () => {
    const t = token();
    const ready = await investor(w, "Ready Investor");
    const cooling = await investor(w, "Cooling Investor", { active: false });
    const revoked = await investor(w, "Revoked Investor");
    const owed = [
      { subjectId: ready.subjectId, amountPaisa: 5_000n },
      { subjectId: cooling.subjectId, amountPaisa: 3_000n },
      { subjectId: revoked.subjectId, amountPaisa: 2_000n },
    ];
    await rentOwed(w, t, 1n, owed);
    await revoke(w.db, revoked.subjectId, "officer:amna", "Sanctions list update, under investigation");
    await finalizedDistribution(w, t, 1n, 10_000n);
    await passRecon(w);

    // Nobody payable at all: nothing to send.
    const t0 = token();
    await finalizedDistribution(w, t0, 1n, 3_000n);
    await expect(w.bank.createPayoutBatch({ token: t0, distributionId: 1n, items: [{ subjectId: cooling.subjectId, amountPaisa: 3_000n }], createdBy: "operator:maker" })).rejects.toThrow(/nothing to pay/);

    const batch = await w.bank.createPayoutBatch({ token: t, distributionId: 1n, items: owed, createdBy: "operator:maker" });
    const { rows: items } = await w.db.query<{ line_no: number; held: boolean; held_reason: string | null }>(
      "SELECT line_no, held, held_reason FROM bank.payout_items WHERE batch_id = $1 ORDER BY line_no", [batch.toString()]);
    expect(items).toEqual([
      { line_no: 1, held: false, held_reason: null },
      { line_no: 2, held: true, held_reason: "no active payout account" },
      { line_no: 3, held: true, held_reason: "investor is revoked" },
    ]);
    await decidePayoutBatch(w.db, batch, "operator:checker", "approve", "Held lines checked, rest is correct");
    const escrowBefore = await escrowBalance(w);
    const sent = await w.bank.submitPayoutBatch(batch, w.mock);
    expect(sent.file).toContain(ready.iban);
    expect(sent.file).not.toContain(cooling.iban);
    expect(await escrowBalance(w)).toBe(escrowBefore - 5_000n);
    expect(await balanceOf(w.db, `rent:payable:${ready.subjectId}`)).toBe(0n);
    expect(await balanceOf(w.db, `rent:payable:${cooling.subjectId}`)).toBe(-3_000n); // still owed
    expect(await balanceOf(w.db, `rent:payable:${revoked.subjectId}`)).toBe(-2_000n);
    expect(await escrowBalance(w)).toBe(w.mock.balancePaisa);
    expect(await cashFindings(w)).toEqual([]);

    // Follow-up: only held shares, only payable investors, each once.
    await expect(w.bank.createFollowupBatch({ parentBatchId: batch, subjectIds: [cooling.subjectId], createdBy: "operator:maker" })).rejects.toThrow(/no active payout account/);
    await expect(w.bank.createFollowupBatch({ parentBatchId: batch, subjectIds: [ready.subjectId], createdBy: "operator:maker" })).rejects.toThrow(/no held share/);
    await expect(w.bank.createFollowupBatch({ parentBatchId: batch, subjectIds: [revoked.subjectId], createdBy: "operator:maker" })).rejects.toThrow(/investor is revoked/);
    await ageCoolingOff(w, cooling.subjectId);
    const follow = await w.bank.createFollowupBatch({ parentBatchId: batch, subjectIds: [cooling.subjectId], createdBy: "operator:maker" });
    await expect(w.bank.createFollowupBatch({ parentBatchId: batch, subjectIds: [cooling.subjectId], createdBy: "operator:maker" })).rejects.toThrow(/already in a follow-up/);
    await expect(decidePayoutBatch(w.db, follow, "operator:maker", "approve", "approving my own batch")).rejects.toThrow(/maker-checker/);
    await decidePayoutBatch(w.db, follow, "operator:checker", "approve", "Cooling-off over, account checked");
    const second = await w.bank.submitPayoutBatch(follow, w.mock);
    expect(second.file).toContain(cooling.iban);
    expect(await balanceOf(w.db, `rent:payable:${cooling.subjectId}`)).toBe(0n);
    const { rows: keys } = await w.db.query<{ key: string }>("SELECT j.idempotency_key AS key FROM bank.payout_batches b JOIN ledger.journal j ON j.id = b.journal_id WHERE b.id = $1", [follow.toString()]);
    expect(keys[0]?.key).toBe(`rent:payout:${t}:1:followup:${follow.toString()}`);
    expect(await escrowBalance(w)).toBe(w.mock.balancePaisa);
    expect(await cashFindings(w)).toEqual([]);
    expect(await verifyAudit(w.db)).toEqual([]);

    // H-4: moving a line from held to paid afterwards is found by the audit.
    await w.db.query("ALTER TABLE bank.payout_items DISABLE TRIGGER payout_items_append_only");
    await w.db.query("UPDATE bank.payout_items SET held = false, held_reason = NULL, payee_id = (SELECT id FROM bank.payees WHERE subject_id = $2 LIMIT 1) WHERE batch_id = $1 AND line_no = 3", [batch.toString(), revoked.subjectId]);
    await w.db.query("ALTER TABLE bank.payout_items ENABLE TRIGGER payout_items_append_only");
    expect((await verifyAudit(w.db)).map((x) => x.problem)).toEqual([expect.stringMatching(/payout batch \d+ or its items changed after creation/)]);
    await w.db.query("ALTER TABLE bank.payout_items DISABLE TRIGGER payout_items_append_only");
    await w.db.query("UPDATE bank.payout_items SET held = true, held_reason = 'investor is revoked', payee_id = NULL WHERE batch_id = $1 AND line_no = 3", [batch.toString()]);
    await w.db.query("ALTER TABLE bank.payout_items ENABLE TRIGGER payout_items_append_only");
    expect(await verifyAudit(w.db)).toEqual([]);
  });

  it("a freeze, a changed account or a revoked investor after approval stops the submission; the ledger refuses overpaying", async () => {
    const t = token();
    const a = await investor(w, "Late Change");
    await rentOwed(w, t, 1n, [{ subjectId: a.subjectId, amountPaisa: 9_000n }]);
    await finalizedDistribution(w, t, 1n, 9_000n);
    await passRecon(w);
    const batch = await w.bank.createPayoutBatch({ token: t, distributionId: 1n, items: [{ subjectId: a.subjectId, amountPaisa: 9_000n }], createdBy: "operator:maker" });
    await decidePayoutBatch(w.db, batch, "operator:checker", "approve", "Checked against the distribution");

    await freezeRecon(w);
    await expect(w.bank.submitPayoutBatch(batch, w.mock)).rejects.toThrow(/blocked by reconciliation/);
    await passRecon(w); // still frozen: only two operators can unfreeze
    await expect(w.bank.submitPayoutBatch(batch, w.mock)).rejects.toThrow(/frozen/);
    await w.db.query("SELECT recon.request_unfreeze('operator:ali', 'Freeze from the test investigated')");
    const { rows } = await w.db.query<{ id: string }>("SELECT id FROM recon.unfreeze_requests WHERE status = 'open'");
    await w.db.query("SELECT recon.decide_unfreeze($1, 'operator:sara', 'approve', 'Investigation notes checked')", [rows[0]?.id]);

    await w.bank.registerPayee(a.subjectId, newAccount(w, "Late Change", "UNIL"));
    await expect(w.bank.submitPayoutBatch(batch, w.mock)).rejects.toThrow(/payout account changed or not active/);
    await ageCoolingOff(w, a.subjectId);
    await expect(w.bank.submitPayoutBatch(batch, w.mock)).rejects.toThrow(/payout account changed or not active/); // approved for the OLD account

    const t2 = token();
    const c = await investor(w, "Overpaid Investor");
    await rentOwed(w, t2, 1n, [{ subjectId: c.subjectId, amountPaisa: 1_000n }]);
    await finalizedDistribution(w, t2, 1n, 1_500n);
    const over = await w.bank.createPayoutBatch({ token: t2, distributionId: 1n, items: [{ subjectId: c.subjectId, amountPaisa: 1_500n }], createdBy: "operator:maker" });
    await decidePayoutBatch(w.db, over, "operator:checker", "approve", "Looks fine to the checker");
    await expect(w.bank.submitPayoutBatch(over, w.mock)).rejects.toThrow(/insufficient balance/);
    const { rows: st } = await w.db.query<{ status: string }>("SELECT status FROM bank.payout_batches WHERE id = $1", [over.toString()]);
    expect(st[0]?.status).toBe("approved");
    expect(await escrowBalance(w)).toBe(w.mock.balancePaisa);
  });

  it("submitting a distribution batch enqueues its on-chain payout record in the same transaction, once (Step 5h)", async () => {
    const registry = `0x${"d1".repeat(20)}`;
    const bank = new BankService(w.pool, w.peppers, w.dataKey, w.mock, { escrowAccount: ESCROW, distributionRegistry: registry });
    const t = token();
    const a = await investor(w, "Recorded Payout");
    await rentOwed(w, t, 3n, [{ subjectId: a.subjectId, amountPaisa: 6_000n }]);
    await finalizedDistribution(w, t, 3n, 6_000n);
    await passRecon(w);
    const batch = await bank.createPayoutBatch({ token: t, distributionId: 3n, items: [{ subjectId: a.subjectId, amountPaisa: 6_000n }], createdBy: "operator:maker" });
    await decidePayoutBatch(w.db, batch, "operator:checker", "approve", "Matches the distribution");

    // A failing submission (gate closed) leaves no command behind.
    await freezeRecon(w);
    await expect(bank.submitPayoutBatch(batch, w.mock)).rejects.toThrow(/blocked by reconciliation/);
    const none = await w.db.query("SELECT 1 FROM outbox.commands WHERE kind = 'rent.record_payout' AND payload->>'distributionId' = '3' AND payload->>'registry' = $1", [registry]);
    expect(none.rows).toHaveLength(0);
    await w.db.query("SELECT recon.request_unfreeze('operator:ali', 'Test freeze investigated and resolved')");
    await passRecon(w);
    const { rows: req } = await w.db.query<{ id: string }>("SELECT id FROM recon.unfreeze_requests WHERE status = 'open'");
    await w.db.query("SELECT recon.decide_unfreeze($1, 'operator:sara', 'approve', 'Checked the investigation notes')", [req[0]?.id]);

    const sent = await bank.submitPayoutBatch(batch, w.mock);
    await bank.submitPayoutBatch(batch, w.mock); // crash and retry
    const { rows } = await w.db.query<{ key: string; payload: Record<string, string>; status: string }>(
      "SELECT idempotency_key AS key, payload, status FROM outbox.commands WHERE kind = 'rent.record_payout' AND payload->>'registry' = $1", [registry]);
    expect(rows).toEqual([{ key: `rent.record_payout:${t}:3`, payload: { registry, distributionId: "3", payoutBatchHash: sent.fileSha256 }, status: "pending" }]);
    expect(await escrowBalance(w)).toBe(w.mock.balancePaisa);
  });

  it("a sealed account swapped between investors is detected before any file is written", async () => {
    const t = token();
    const a = await investor(w, "Swap Victim");
    const b = await investor(w, "Swap Attacker");
    await rentOwed(w, t, 1n, [{ subjectId: a.subjectId, amountPaisa: 5_000n }]);
    await finalizedDistribution(w, t, 1n, 5_000n);
    await passRecon(w);
    const batch = await w.bank.createPayoutBatch({ token: t, distributionId: 1n, items: [{ subjectId: a.subjectId, amountPaisa: 5_000n }], createdBy: "operator:maker" });
    await decidePayoutBatch(w.db, batch, "operator:checker", "approve", "Checked against the distribution");
    // A rogue administrator copies the attacker's sealed IBAN into the victim's payout account.
    await w.db.query("ALTER TABLE bank.payees DISABLE TRIGGER payees_guard");
    await w.db.query(
      `UPDATE bank.payees v SET iban_enc = x.iban_enc FROM bank.payees x
       WHERE v.subject_id = $1 AND v.superseded_at IS NULL AND x.subject_id = $2 AND x.superseded_at IS NULL`,
      [a.subjectId, b.subjectId],
    );
    await w.db.query("ALTER TABLE bank.payees ENABLE TRIGGER payees_guard");
    await expect(w.bank.submitPayoutBatch(batch, w.mock)).rejects.toSatisfy((e: unknown) => e instanceof BankError && e.code === "TAMPERED");
  });
});

describe("records (B-7) and roles", () => {
  it("bank tables are append-only, even for the administrator", async () => {
    for (const t of ["events", "payment_intents", "credits", "credit_returns", "payout_items", "payout_returns", "audit"]) {
      const { rows } = await w.db.query<{ n: string }>(`SELECT count(*) AS n FROM bank.${t}`);
      expect(Number(rows[0]?.n), t).toBeGreaterThan(0);
      await expect(w.db.query(`DELETE FROM bank.${t}`)).rejects.toThrow(/append-only/);
      await expect(w.db.query(`TRUNCATE bank.${t} CASCADE`)).rejects.toThrow(/append-only/);
    }
    await expect(w.db.query("UPDATE bank.credits SET status = 'matched'")).rejects.toThrow(/append-only/);
    await expect(w.db.query("UPDATE bank.payout_batches SET total_paisa = total_paisa + 1")).rejects.toThrow(/cannot change/);
    await expect(w.db.query("DELETE FROM bank.payout_batches")).rejects.toThrow(/never deleted/);
  });

  it("roles: the service cannot approve, operators cannot ingest, readers see no account data", async () => {
    const as = async (role: string, sql: string): Promise<unknown> => {
      const c = new pg.Client(w.settings);
      await c.connect();
      try {
        await c.query("BEGIN");
        await c.query(`SET LOCAL ROLE ${role}`);
        return (await c.query(sql)).rows;
      } finally {
        await c.end();
      }
    };
    await expect(as("pt_bank_service", "SELECT bank.decide_payout_batch(1, 'svc', 'approve', 'the service approving')")).rejects.toThrow(/permission denied/);
    await expect(as("pt_bank_operator", "SELECT bank.ingest_event('evt_role00001', 'credit.received', ''::bytea, 'k1', '{}', 'op')")).rejects.toThrow(/permission denied/);
    await expect(as("pt_bank_reader", "SELECT iban_hash FROM bank.payees")).rejects.toThrow(/permission denied/);
    await expect(as("pt_bank_reader", "SELECT count(*) FROM bank.payee_status")).resolves.toBeDefined();
    await expect(as("pt_bank_service", `UPDATE ledger.accounts SET code = 'x' WHERE code = '${ESCROW_LEDGER}'`)).rejects.toThrow(/permission denied/);
  });
});
