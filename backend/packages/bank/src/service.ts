import { randomInt } from "node:crypto";
import { normalizeName, type Peppers, seal, unseal } from "@pt/kyc";
import type pg from "pg";
import { z } from "zod";
import { parseIban } from "./iban.ts";
import { fileSha256, formatPayoutFile, type PayoutFile } from "./payout-file.ts";
import { bodyHash, type WebhookHandler } from "./webhook.ts";

/**
 * Bank side of the platform (ADR 0009): Raast credits from signed webhooks, payment codes, payout
 * accounts and payout batches. Every money rule is enforced in the database (migration 0009, B-1..B-7);
 * this service verifies signatures, keeps IBANs out of the database (keyed hash + sealed copy) and
 * writes the bank file.
 */

type Db = pg.Pool | pg.ClientBase;

/** The bank's account-title inquiry (1LINK / Raast title fetch in production). */
export interface TitleFetch {
  accountTitle(iban: string): Promise<string | null>;
}

/** Where payout files and credit returns go (the bank's API in production, MockBank here). */
export interface BankGateway {
  submitPayoutFile(file: string): Promise<void>;
  returnCredit(raastRef: string): Promise<void>;
}

export class BankError extends Error {
  constructor(
    readonly code: "INVALID_INPUT" | "TITLE_NOT_FOUND" | "TAMPERED",
    message: string,
  ) {
    super(message);
    this.name = "BankError";
  }
}

// ------------------------------------------------------------------ events from the bank
const paisa = z.string().regex(/^[1-9][0-9]{0,14}$/);
const creditEvent = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/),
  type: z.literal("credit.received"),
  createdAt: z.iso.datetime(),
  data: z.strictObject({
    raastRef: z.string().regex(/^[A-Z0-9][A-Z0-9-]{3,63}$/),
    amountPaisa: paisa,
    valueDate: z.iso.date(),
    payer: z.strictObject({ iban: z.string().max(40), title: z.string().max(140) }),
    narration: z.string().max(140),
  }),
});
const returnEvent = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/),
  type: z.literal("payout.returned"),
  createdAt: z.iso.datetime(),
  data: z.strictObject({
    batchReference: z.string().regex(/^PTPAY-[0-9A-Z-]{4,40}$/),
    lineNo: z.number().int().min(1).max(50_000),
    returnRef: z.string().regex(/^[A-Z0-9][A-Z0-9-]{3,63}$/),
    amountPaisa: paisa,
    reason: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  }),
});
const bankEvent = z.discriminatedUnion("type", [creditEvent, returnEvent]);
export type BankEvent = z.infer<typeof bankEvent>;

const INTENT_CODE = /PT-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface IngestResult {
  status: "processed" | "duplicate" | "conflict";
  outcome?: string;
}

export interface BankServiceOptions {
  /** The trustee escrow account's id at the bank, as in its statements (e.g. TRUSTEE-ESCROW-01). */
  escrowAccount: string;
  actor?: string;
  /**
   * The DistributionRegistry to record paid distributions in (Step 5h). When set, submitting a
   * distribution batch also enqueues an outbox command rent.record_payout(id, SHA-256 of the bank
   * file) in the SAME transaction, so a payout that left escrow is always recorded on chain.
   */
  distributionRegistry?: string;
}

export class BankService implements WebhookHandler {
  private readonly actor: string;

  constructor(
    private readonly db: pg.Pool,
    private readonly peppers: Peppers,
    private readonly dataKey: Buffer,
    private readonly titles: TitleFetch,
    private readonly opts: BankServiceOptions,
  ) {
    this.actor = opts.actor ?? "bank-service";
  }

  /** WebhookHandler: the body's signature was already verified by the webhook server. */
  async handle(rawBody: string, keyId: string): Promise<{ status: number; body: unknown }> {
    let event: BankEvent;
    try {
      event = bankEvent.parse(JSON.parse(rawBody));
    } catch {
      return { status: 400, body: { error: "bad_event" } };
    }
    try {
      const r = await this.ingest(event, rawBody, keyId);
      return { status: r.status === "conflict" ? 409 : 200, body: r };
    } catch (e) {
      // The database refused the content (malformed, unknown batch, wrong amount): retrying cannot help.
      if ((e as { code?: string }).code === "23514" || (e as { code?: string }).code === "P0002") return { status: 422, body: { error: "rejected" } };
      throw e;
    }
  }

  /** Normalises an event (the payer's IBAN becomes a keyed hash and last four digits) and records it once. */
  async ingest(event: BankEvent, rawBody: string, keyId: string): Promise<IngestResult> {
    let payload: Record<string, unknown>;
    if (event.type === "credit.received") {
      let iban: string;
      try {
        iban = parseIban(event.data.payer.iban).iban;
      } catch {
        iban = event.data.payer.iban.replace(/\s+/g, "").toUpperCase();
      }
      const last4 = /[0-9]{4}$/.exec(iban)?.[0] ?? "0000";
      payload = {
        raastRef: event.data.raastRef,
        amountPaisa: event.data.amountPaisa,
        valueDate: event.data.valueDate,
        payerHash: this.peppers.hash(this.peppers.current.version, "iban", iban).toString("hex"),
        payerLast4: last4,
        intentCode: INTENT_CODE.exec(event.data.narration.toUpperCase())?.[0] ?? null,
      };
    } else {
      payload = { ...event.data };
    }
    const { rows } = await this.db.query<{ r: IngestResult }>(
      "SELECT bank.ingest_event($1, $2, $3, $4, $5::jsonb, $6) AS r",
      [event.id, event.type, bodyHash(rawBody), keyId, JSON.stringify(payload), this.actor],
    );
    const r = rows[0]?.r;
    if (!r) throw new Error("no result from bank.ingest_event");
    return r;
  }

  /** A payment code the payer types in the Raast narration. Returns the code. */
  async createIntent(input: {
    purpose: "subscription" | "rent_collection";
    subjectId: string | null;
    amountPaisa: bigint;
    ledgerKey: string;
    creditAccount: string;
    ttlMinutes?: number;
  }): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = `PT-${randomCode(4)}-${randomCode(4)}`;
      try {
        const { rows } = await this.db.query<{ code: string }>(
          "SELECT bank.create_intent($1, $2, $3, $4, $5, $6, $7, $8) AS code",
          [code, input.purpose, input.subjectId, input.amountPaisa.toString(), input.ledgerKey, input.creditAccount, input.ttlMinutes ?? 1440, this.actor],
        );
        return rows[0]?.code ?? code;
      } catch (e) {
        // A code collision (1 in 2^40) gets a new code; any other refusal is final.
        if ((e as { code?: string; message?: string }).code === "23505" && /payment code/.test((e as Error).message)) continue;
        throw e;
      }
    }
    throw new Error("could not allocate a payment code");
  }

  /**
   * B-4: registers or changes the investor's payout account after a title inquiry. Usable 72 hours
   * later; the database alerts on every change.
   */
  async registerPayee(subjectId: string, ibanInput: string): Promise<bigint> {
    let iban: ReturnType<typeof parseIban>;
    try {
      iban = parseIban(ibanInput);
    } catch (e) {
      throw new BankError("INVALID_INPUT", (e as Error).message);
    }
    const title = await this.titles.accountTitle(iban.iban);
    if (!title) throw new BankError("TITLE_NOT_FOUND", "the bank did not return a title for this account");
    const version = this.peppers.current.version;
    const { rows } = await this.db.query<{ id: string }>(
      "SELECT bank.register_payee($1, $2, $3, $4, $5, $6, $7) AS id",
      [
        subjectId,
        this.peppers.hash(version, "iban", iban.iban),
        seal(this.dataKey, ibanAad(subjectId), iban.iban),
        iban.last4,
        iban.bankCode,
        this.peppers.hash(version, "name", normalizeName(title)),
        this.actor,
      ],
    );
    return BigInt(rows[0]?.id ?? "0");
  }

  /** B-5 maker: a payout batch for a finalized distribution. Returns the batch id. */
  async createPayoutBatch(input: { token: string; distributionId: bigint; items: { subjectId: string; amountPaisa: bigint }[]; createdBy: string }): Promise<bigint> {
    const reference = `PTPAY-${input.token.slice(2, 10).toUpperCase()}-${input.distributionId.toString()}-${randomCode(4)}`;
    const { rows } = await this.db.query<{ id: string }>(
      "SELECT bank.create_payout_batch($1, $2, $3, $4::jsonb, $5) AS id",
      [reference, input.token, input.distributionId.toString(), JSON.stringify(input.items.map((i) => ({ subject: i.subjectId, amountPaisa: i.amountPaisa.toString() }))), input.createdBy],
    );
    return BigInt(rows[0]?.id ?? "0");
  }

  /**
   * H-3 (ADR 0009 decision 2): pays shares held in a submitted distribution batch to investors who
   * can now be paid. Same maker-checker, gate and submission as any batch. Returns the batch id.
   */
  async createFollowupBatch(input: { parentBatchId: bigint; subjectIds: string[]; createdBy: string }): Promise<bigint> {
    const { rows: parent } = await this.db.query<{ reference: string }>("SELECT reference FROM bank.payout_batches WHERE id = $1", [input.parentBatchId.toString()]);
    const base = (parent[0]?.reference ?? "PTPAY-UNKNOWN").slice(0, 34);
    const { rows } = await this.db.query<{ id: string }>(
      "SELECT bank.create_followup_batch($1, $2, $3::jsonb, $4) AS id",
      [`${base}-F${randomCode(4)}`, input.parentBatchId.toString(), JSON.stringify(input.subjectIds), input.createdBy],
    );
    return BigInt(rows[0]?.id ?? "0");
  }

  /**
   * B-5/B-6: writes the bank file of an approved batch, records its SHA-256 and books the payout in
   * one transaction, THEN sends it. Calling again after a crash rebuilds the same bytes, gets the same
   * journal back and re-sends (the bank de-duplicates by reference).
   */
  async submitPayoutBatch(batchId: bigint, gateway: BankGateway): Promise<{ journalId: bigint; fileSha256: string; file: string }> {
    const file = await this.payoutFile(batchId);
    const sha = fileSha256(file);
    const fileHash = `0x${sha.toString("hex")}`;
    const c = await this.db.connect();
    let journalId: bigint;
    try {
      await c.query("BEGIN");
      const { rows } = await c.query<{ id: string }>("SELECT bank.submit_payout_batch($1, $2, $3) AS id", [batchId.toString(), this.actor, sha]);
      journalId = BigInt(rows[0]?.id ?? "0");
      const { rows: b } = await c.query<{ kind: string; token: string; distribution_id: string }>(
        "SELECT kind, token, distribution_id::text FROM bank.payout_batches WHERE id = $1", [batchId.toString()]);
      const batch = b[0];
      if (this.opts.distributionRegistry && batch?.kind === "distribution") {
        // Idempotent (outbox O-2): a re-submission after a crash finds the same command.
        await c.query("SELECT outbox.enqueue($1, 'rent.record_payout', $2::jsonb, $3, $4)", [
          `rent.record_payout:${batch.token}:${batch.distribution_id}`,
          JSON.stringify({ registry: this.opts.distributionRegistry.toLowerCase(), distributionId: batch.distribution_id, payoutBatchHash: fileHash }),
          `bank:batch:${batchId.toString()}`,
          this.actor,
        ]);
      }
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    await gateway.submitPayoutFile(file);
    return { journalId, fileSha256: fileHash, file };
  }

  /** The deterministic bank file of an approved or submitted batch. Refuses a swapped or edited account. */
  async payoutFile(batchId: bigint): Promise<string> {
    const { rows } = await this.db.query<{ reference: string; line_no: number; subject_id: string; iban_enc: Buffer; iban_hash: Buffer; bank_code: string; amount_paisa: string }>(
      "SELECT * FROM bank.payout_file_rows($1)",
      [batchId.toString()],
    );
    if (rows.length === 0) throw new BankError("INVALID_INPUT", `payout batch ${batchId.toString()} is not approved`);
    const lines = rows.map((r) => {
      let iban: string;
      try {
        iban = unseal(this.dataKey, ibanAad(r.subject_id), r.iban_enc);
      } catch {
        throw new BankError("TAMPERED", `line ${String(r.line_no)}: the sealed account does not belong to this investor`);
      }
      if (!this.peppers.hash(this.peppers.current.version, "iban", iban).equals(r.iban_hash)) {
        throw new BankError("TAMPERED", `line ${String(r.line_no)}: the account does not match its registered hash`);
      }
      return { lineNo: r.line_no, iban, bankCode: r.bank_code, amountPaisa: BigInt(r.amount_paisa), beneficiaryRef: r.subject_id.replaceAll("-", "").slice(0, 8) };
    });
    const f: PayoutFile = {
      reference: rows[0]?.reference ?? "",
      debitAccount: this.opts.escrowAccount,
      totalPaisa: lines.reduce((s, l) => s + l.amountPaisa, 0n),
      lines,
    };
    return formatPayoutFile(f);
  }

  /** Sends a suspense credit back to its sender: recorded (with the gate) first, then instructed. */
  async returnCredit(raastRef: string, operator: string, reason: string, gateway: BankGateway): Promise<bigint> {
    const { rows } = await this.db.query<{ id: string }>("SELECT bank.return_credit($1, $2, $3) AS id", [raastRef, operator, reason]);
    await gateway.returnCredit(raastRef);
    return BigInt(rows[0]?.id ?? "0");
  }
}

const ibanAad = (subjectId: string): string => `pt-iban-v1:${subjectId}`;

function randomCode(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += CROCKFORD.charAt(randomInt(CROCKFORD.length));
  return s;
}

// ------------------------------------------------------------------ operator API (pt_bank_operator)

/** B-5 checker: a different operator approves (the reconciliation gate must be open) or rejects. */
export async function decidePayoutBatch(db: Db, batchId: bigint, operator: string, decision: "approve" | "reject", reason: string): Promise<string> {
  const { rows } = await db.query<{ s: string }>("SELECT bank.decide_payout_batch($1, $2, $3, $4) AS s", [batchId.toString(), operator, decision, reason]);
  return rows[0]?.s ?? "";
}

export async function verifyAudit(db: Db): Promise<{ auditId: string | null; problem: string }[]> {
  const { rows } = await db.query<{ audit_id: string | null; problem: string }>("SELECT audit_id::text, problem FROM bank.verify_audit()");
  return rows.map((r) => ({ auditId: r.audit_id, problem: r.problem }));
}
