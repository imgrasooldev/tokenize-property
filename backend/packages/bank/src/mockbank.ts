import { randomBytes } from "node:crypto";
import { buildStatement, pktDate, type Statement } from "@pt/recon";
import { parseIban } from "./iban.ts";
import { fileSha256, parsePayoutFile } from "./payout-file.ts";
import type { BankGateway, TitleFetch } from "./service.ts";
import { signWebhook, type WebhookKey } from "./webhook.ts";

/**
 * MOCK bank (local development and tests). It plays the OUTSIDE party: it keeps its own record of
 * the trustee escrow account, independent of the platform's ledger, and only talks to the platform
 * through signed webhooks, payout files and daily statements. Reconciliation can therefore catch
 * the platform and the bank disagreeing (a lost webhook, a double booking, a wrong amount).
 *
 * Accounts at "other banks" are a title registry: openAccount(iban, title). Payouts to an account
 * marked closed are paid back the same day as a return (payout.returned event).
 */

export interface MockBankOptions {
  /** The escrow account id used in statements (e.g. TRUSTEE-ESCROW-01). */
  account: string;
  key: WebhookKey;
  /** Delivers one signed event; returns the HTTP status. Default: POST to webhookUrl. */
  deliver?: (rawBody: string, signature: string) => Promise<number>;
  webhookUrl?: string;
  now?: () => Date;
}

interface Entry {
  date: string;
  amountPaisa: bigint;
  reference: string;
  counterparty: string;
}

export interface DeliveredEvent {
  id: string;
  rawBody: string;
  status: number;
}

export class MockBank implements TitleFetch, BankGateway {
  private readonly entries: Entry[] = [];
  private readonly titles = new Map<string, string>();
  private readonly closed = new Set<string>();
  private readonly credits = new Map<string, { amountPaisa: bigint; returned: boolean }>();
  private readonly files = new Map<string, string>();
  private readonly pendingReturns: { reference: string; lineNo: number; amountPaisa: bigint }[] = [];
  readonly delivered: DeliveredEvent[] = [];
  private readonly now: () => Date;

  constructor(private readonly opts: MockBankOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  openAccount(iban: string, title: string): void {
    this.titles.set(parseIban(iban).iban, title);
  }

  closeAccount(iban: string): void {
    this.closed.add(parseIban(iban).iban);
  }

  accountTitle(iban: string): Promise<string | null> {
    return Promise.resolve(this.titles.get(parseIban(iban).iban) ?? null);
  }

  get balancePaisa(): bigint {
    return this.entries.reduce((s, e) => s + e.amountPaisa, 0n);
  }

  /**
   * Someone sends money to the escrow account by Raast. The bank books it first, then notifies the
   * platform (a failed delivery does not undo the credit: the statement still shows it).
   */
  async receiveRaast(input: { payerIban: string; amountPaisa: bigint; narration: string; deliver?: boolean }): Promise<{ raastRef: string; event: DeliveredEvent | null }> {
    if (input.amountPaisa <= 0n) throw new Error("amount must be positive");
    const raastRef = `RAAST-${randomBytes(6).toString("hex").toUpperCase()}`;
    const payer = parseIban(input.payerIban).iban;
    this.book(input.amountPaisa, raastRef, `Raast credit from ****${payer.slice(-4)}`);
    this.credits.set(raastRef, { amountPaisa: input.amountPaisa, returned: false });
    const event = {
      id: `evt_${randomBytes(12).toString("hex")}`,
      type: "credit.received",
      createdAt: this.now().toISOString(),
      data: {
        raastRef,
        amountPaisa: input.amountPaisa.toString(),
        valueDate: pktDate(this.now()),
        payer: { iban: payer, title: this.titles.get(payer) ?? "UNKNOWN" },
        narration: input.narration,
      },
    };
    return { raastRef, event: input.deliver === false ? this.record(event) : await this.send(event) };
  }

  /** BankGateway: executes a payout file. The same file again is ignored; a different one with the same reference is refused. */
  submitPayoutFile(text: string): Promise<void> {
    const f = parsePayoutFile(text);
    const previous = this.files.get(f.reference);
    if (previous !== undefined) {
      if (previous === fileSha256(text).toString("hex")) return Promise.resolve();
      return Promise.reject(new Error(`a different payout file with reference ${f.reference} was already executed`));
    }
    if (f.debitAccount !== this.opts.account) return Promise.reject(new Error("payout file debits another account"));
    if (this.balancePaisa < f.totalPaisa) return Promise.reject(new Error("insufficient funds in the escrow account"));
    this.files.set(f.reference, fileSha256(text).toString("hex"));
    this.book(-f.totalPaisa, f.reference, `Payout batch, ${String(f.lines.length)} beneficiaries`);
    for (const l of f.lines) if (this.closed.has(l.iban)) this.pendingReturns.push({ reference: f.reference, lineNo: l.lineNo, amountPaisa: l.amountPaisa });
    return Promise.resolve();
  }

  /** Payout lines to closed accounts come back: credit to escrow plus a payout.returned event. */
  async processReturns(): Promise<DeliveredEvent[]> {
    const out: DeliveredEvent[] = [];
    for (const r of this.pendingReturns.splice(0)) {
      const returnRef = `RTN-${randomBytes(6).toString("hex").toUpperCase()}`;
      this.book(r.amountPaisa, returnRef, `Return of ${r.reference} line ${String(r.lineNo)}`);
      out.push(await this.send({
        id: `evt_${randomBytes(12).toString("hex")}`,
        type: "payout.returned",
        createdAt: this.now().toISOString(),
        data: { batchReference: r.reference, lineNo: r.lineNo, returnRef, amountPaisa: r.amountPaisa.toString(), reason: "account_closed" },
      }));
    }
    return out;
  }

  /** BankGateway: sends a credit back to its sender, under the same reference. */
  returnCredit(raastRef: string): Promise<void> {
    const c = this.credits.get(raastRef);
    if (!c) return Promise.reject(new Error(`unknown credit ${raastRef}`));
    if (c.returned) return Promise.resolve();
    c.returned = true;
    this.book(-c.amountPaisa, raastRef, "Return to sender");
    return Promise.resolve();
  }

  /** Delivers an earlier event again, byte for byte (the bank's retry, or an attacker's replay). */
  async redeliver(eventId: string, signedAt?: Date): Promise<number> {
    const e = this.delivered.find((x) => x.id === eventId);
    if (!e) throw new Error(`unknown event ${eventId}`);
    return this.post(e.rawBody, signedAt);
  }

  /** The day's statement in the pt-mock-bank-v1 format (ADR 0007). */
  statement(date: string): Statement {
    const before = this.entries.filter((e) => e.date < date).reduce((s, e) => s + e.amountPaisa, 0n);
    const lines = this.entries.filter((e) => e.date === date).map((e) => ({ valueDate: e.date, amountPaisa: e.amountPaisa, reference: e.reference, counterparty: e.counterparty }));
    return buildStatement(this.opts.account, date, before, lines);
  }

  private book(amountPaisa: bigint, reference: string, counterparty: string): void {
    this.entries.push({ date: pktDate(this.now()), amountPaisa, reference, counterparty });
  }

  private record(event: { id: string } & Record<string, unknown>): DeliveredEvent {
    const d = { id: event.id, rawBody: JSON.stringify(event), status: 0 };
    this.delivered.push(d);
    return d;
  }

  private async send(event: { id: string } & Record<string, unknown>): Promise<DeliveredEvent> {
    const d = this.record(event);
    d.status = await this.post(d.rawBody);
    return d;
  }

  private async post(rawBody: string, signedAt?: Date): Promise<number> {
    const signature = signWebhook(this.opts.key, rawBody, (signedAt ?? this.now()).getTime());
    if (this.opts.deliver) return this.opts.deliver(rawBody, signature);
    if (!this.opts.webhookUrl) throw new Error("no webhook delivery configured");
    const res = await fetch(this.opts.webhookUrl, { method: "POST", headers: { "content-type": "application/json", "x-pt-bank-signature": signature }, body: rawBody });
    return res.status;
  }
}
