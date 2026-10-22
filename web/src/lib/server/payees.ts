import { db } from "./db";

/**
 * The signed-in investor's payout accounts (migration 0022 WA-2): last four digits, bank code, when
 * registered, when usable (after the 72-hour cooling-off) and when replaced. Registration goes to the
 * bank service (services.ts registerPayoutAccount), which holds the keys; the website never sees an
 * IBAN again after the form.
 */
export interface PayoutAccount {
  payeeId: string;
  last4: string;
  bankCode: string;
  registeredAt: string;
  activeFrom: string;
  supersededAt: string | null;
}

export type PayeeState = "active" | "cooling" | "replaced";

export function payeeState(p: Pick<PayoutAccount, "activeFrom" | "supersededAt">, now: number): PayeeState {
  if (p.supersededAt !== null) return "replaced";
  return new Date(p.activeFrom).getTime() <= now ? "active" : "cooling";
}

/** Masked display: only the last four digits are ever shown. */
export function maskedIban(last4: string): string {
  return `PK•• •••• •••• •••• •••• ${/^[0-9]{4}$/.test(last4) ? last4 : "••••"}`;
}

export async function payoutAccounts(subjectId: string | null): Promise<PayoutAccount[] | null> {
  if (!subjectId) return [];
  try {
    const { rows } = await (await db()).query<{ payee_id: string; last4: string; bank_code: string; registered_at: Date; active_from: Date; superseded_at: Date | null }>(
      "SELECT * FROM bank.web_payees($1)",
      [subjectId],
    );
    return rows.map((r) => ({
      payeeId: r.payee_id,
      last4: r.last4,
      bankCode: r.bank_code,
      registeredAt: r.registered_at.toISOString(),
      activeFrom: r.active_from.toISOString(),
      supersededAt: r.superseded_at ? r.superseded_at.toISOString() : null,
    }));
  } catch {
    return null;
  }
}
