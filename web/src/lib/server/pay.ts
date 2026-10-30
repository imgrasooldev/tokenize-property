import { db } from "./db";

/**
 * A tenant's rent invoice by its payment link (migration 0044 RI-2): the database matches the
 * link's SHA-256 and returns only what the tenant needs; unknown or cancelled links give null.
 */
export interface TenantInvoice {
  token: string;
  period: string;
  tenant: string;
  amountPaisa: string;
  due: string;
  code: string;
  status: "open" | "proposed" | "paid";
  account: string;
}

export async function invoiceByLink(link: string): Promise<TenantInvoice | null> {
  if (!/^[A-Za-z0-9_-]{43,64}$/.test(link)) return null;
  const { rows } = await (await db()).query<{ v: TenantInvoice | null }>("SELECT payweb.invoice($1) AS v", [link]);
  return rows[0]?.v ?? null;
}
