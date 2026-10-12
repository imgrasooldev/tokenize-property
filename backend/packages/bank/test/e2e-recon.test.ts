import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { formatStatement, importStatement, parseStatement } from "@pt/recon";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_BODY, SIGNATURE_HEADER, signWebhook, createWebhookServer } from "../src/webhook.ts";
import { decidePayoutBatch, verifyAudit } from "../src/service.ts";
import { verifyAudit as verifyKycAudit } from "@pt/kyc";
import {
  cashFindings,
  escrowBalance,
  finalizedDistribution,
  investor,
  newAccount,
  passRecon,
  refId,
  rentOwed,
  today,
  token,
  world,
  type World,
} from "./setup.ts";

/**
 * Step 5g end to end: the mock bank talks to the platform over real HTTP with signed webhooks, and
 * its own daily statement reconciles with the ledger line by line (ADR 0007 cash check).
 */

let w: World;
let server: Server;
let url = "";

beforeAll(async () => {
  let target = "";
  w = await world({
    deliver: async (raw, sig) => (await fetch(target, { method: "POST", headers: { "content-type": "application/json", [SIGNATURE_HEADER]: sig }, body: raw })).status,
  });
  server = createWebhookServer(w.bank, [w.key]);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  target = `${url}/v1/bank/events`;
});

afterAll(async () => {
  await new Promise<void>((r) => {
    server.close(() => {
      r();
    });
  });
  await w.drop();
});

const post = (body: string, headers: Record<string, string>): Promise<Response> =>
  fetch(`${url}/v1/bank/events`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

describe("webhook endpoint", () => {
  it("refuses unsigned, wrongly signed, stale, oversized and non-JSON requests before touching the database", async () => {
    const body = JSON.stringify({ id: "evt_http000001", type: "credit.received" });
    expect((await post(body, {})).status).toBe(401);
    expect((await post(body, { [SIGNATURE_HEADER]: signWebhook({ id: "k1", secret: Buffer.alloc(32, 3) }, body) })).status).toBe(401);
    expect((await post(body, { [SIGNATURE_HEADER]: signWebhook(w.key, body, Date.now() - 301_000) })).status).toBe(401);
    expect((await post("x".repeat(MAX_BODY + 1), { [SIGNATURE_HEADER]: signWebhook(w.key, "x") })).status).toBe(413);
    expect((await fetch(`${url}/v1/bank/events`, { method: "POST", headers: { "content-type": "text/plain" }, body })).status).toBe(415);
    expect((await fetch(`${url}/v1/bank/other`, { method: "POST" })).status).toBe(404);
    const { rows } = await w.db.query("SELECT 1 FROM bank.events");
    expect(rows).toHaveLength(0);
  });

  it("a captured request replayed within the window is answered as a duplicate and books nothing", async () => {
    const a = await investor(w);
    const code = await w.bank.createIntent({ purpose: "subscription", subjectId: a.subjectId, amountPaisa: 12_345n, ledgerKey: `sub:${refId()}:paid`, creditAccount: `investor:${a.subjectId}:subscriptions` });
    const paid = await w.mock.receiveRaast({ payerIban: a.iban, amountPaisa: 12_345n, narration: code });
    expect(paid.event?.status).toBe(200);
    const raw = paid.event?.rawBody ?? "";
    const r = await post(raw, { [SIGNATURE_HEADER]: signWebhook(w.key, raw) });
    expect(await r.json()).toEqual({ status: "duplicate", outcome: "matched" });
    expect(await escrowBalance(w)).toBe(w.mock.balancePaisa);
  });
});

describe("a business day, reconciled", () => {
  it("subscriptions, a stray payment and its return, rent in and out with a bounced line: the bank statement and the ledger agree", async () => {
    const t = token();
    const ali = await investor(w, "Ali Raza");
    const sara = await investor(w, "Sara Ahmed");
    for (const inv of [ali, sara]) {
      const code = await w.bank.createIntent({ purpose: "subscription", subjectId: inv.subjectId, amountPaisa: 500_000n, ledgerKey: `sub:${refId()}:paid`, creditAccount: `investor:${inv.subjectId}:subscriptions` });
      expect((await w.mock.receiveRaast({ payerIban: inv.iban, amountPaisa: 500_000n, narration: `GPF3 ${code}` })).event?.status).toBe(200);
    }
    const stray = await w.mock.receiveRaast({ payerIban: newAccount(w, "Someone Unknown"), amountPaisa: 77_700n, narration: "wrong reference" });
    await rentOwed(w, t, 1n, [{ subjectId: ali.subjectId, amountPaisa: 30_000n }, { subjectId: sara.subjectId, amountPaisa: 20_000n }]);
    await finalizedDistribution(w, t, 1n, 50_000n);
    w.mock.closeAccount(sara.iban);
    await passRecon(w);
    await w.bank.returnCredit(stray.raastRef, "operator:ali", "Unidentified payment, returned to sender", w.mock);
    const batch = await w.bank.createPayoutBatch({ token: t, distributionId: 1n, items: [{ subjectId: ali.subjectId, amountPaisa: 30_000n }, { subjectId: sara.subjectId, amountPaisa: 20_000n }], createdBy: "operator:maker" });
    await decidePayoutBatch(w.db, batch, "operator:checker", "approve", "Matches the finalized distribution");
    await w.bank.submitPayoutBatch(batch, w.mock);
    expect((await w.mock.processReturns()).map((r) => r.status)).toEqual([200]);

    // The bank's own statement, through the strict file format, into reconciliation's store.
    const date = await today(w);
    const statement = parseStatement(formatStatement(w.mock.statement(date)));
    expect(statement.closingPaisa).toBe(w.mock.balancePaisa);
    await importStatement(w.db, statement, "operator:import");
    expect(await cashFindings(w, statement)).toEqual([]);
    expect(await escrowBalance(w)).toBe(statement.closingPaisa);

    expect(await verifyAudit(w.db)).toEqual([]);
    expect(await verifyKycAudit(w.db)).toEqual([]);
    const { rows } = await w.db.query("SELECT * FROM recon.verify_audit()");
    expect(rows).toEqual([]);
  });

  it("property: whatever mix of payments, mistakes and repeated deliveries, the ledger matches the bank line by line", async () => {
    const inv = await investor(w, "Property Tester");
    const other = newAccount(w, "Random Third Party");
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            kind: fc.constantFrom("exact", "wrong_amount", "no_code", "third_party", "repeat_code"),
            amount: fc.bigInt({ min: 1n, max: 10_000_000n }),
            redeliver: fc.nat({ max: 3 }),
            lost: fc.boolean(),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        async (ops) => {
          let lastCode = "";
          const lost: string[] = [];
          for (const op of ops) {
            let code = lastCode;
            if (op.kind !== "repeat_code" || !lastCode) {
              code = await w.bank.createIntent({ purpose: "subscription", subjectId: inv.subjectId, amountPaisa: op.amount, ledgerKey: `sub:${refId()}:paid`, creditAccount: `investor:${inv.subjectId}:subscriptions` });
            }
            lastCode = code;
            const paid = await w.mock.receiveRaast({
              payerIban: op.kind === "third_party" ? other : inv.iban,
              amountPaisa: op.kind === "wrong_amount" ? op.amount + 1n : op.amount,
              narration: op.kind === "no_code" ? "for property" : code,
              deliver: !op.lost,
            });
            if (op.lost && paid.event) lost.push(paid.event.id);
            if (!op.lost && paid.event) for (let i = 0; i < op.redeliver; i++) await w.mock.redeliver(paid.event.id);
          }
          // Lost deliveries are visible to reconciliation until the bank retries them.
          if (lost.length > 0) expect((await cashFindings(w)).some((f) => f.startsWith("cash.unmatched_bank_line"))).toBe(true);
          for (const id of lost) await w.mock.redeliver(id);
          expect(await escrowBalance(w)).toBe(w.mock.balancePaisa);
          expect(await cashFindings(w)).toEqual([]);
        },
      ),
      { numRuns: 12 },
    );
  }, 120_000);
});
