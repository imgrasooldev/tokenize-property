import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * MOCK payout batch file "pt-mock-payout-v1" sent to the bank (until the real bank's format is
 * known). JSON Lines, UTF-8, deterministic: the same batch always gives the same bytes, so a
 * re-send after a crash has the same SHA-256 as the recorded one (ADR 0009, B-6).
 *
 *   {"type":"header","format":"pt-mock-payout-v1","reference":"PTPAY-...","debitAccount":"TRUSTEE-ESCROW-01","currency":"PKR","totalPaisa":"150000","count":2}
 *   {"type":"line","lineNo":1,"iban":"PK..","bankCode":"MEZN","amountPaisa":"100000","beneficiaryRef":"3f2a9c1e"}
 *   {"type":"trailer","count":2}
 *
 * No names: the bank pays by IBAN; beneficiaryRef is the first 8 hex digits of the KYC subject id.
 */
export const PAYOUT_FORMAT = "pt-mock-payout-v1";

export interface PayoutLine {
  lineNo: number;
  iban: string;
  bankCode: string;
  amountPaisa: bigint;
  beneficiaryRef: string;
}

export interface PayoutFile {
  reference: string;
  debitAccount: string;
  totalPaisa: bigint;
  lines: PayoutLine[];
}

export function formatPayoutFile(f: PayoutFile): string {
  const rows: unknown[] = [
    { type: "header", format: PAYOUT_FORMAT, reference: f.reference, debitAccount: f.debitAccount, currency: "PKR", totalPaisa: f.totalPaisa.toString(), count: f.lines.length },
    ...f.lines.map((l) => ({ type: "line", lineNo: l.lineNo, iban: l.iban, bankCode: l.bankCode, amountPaisa: l.amountPaisa.toString(), beneficiaryRef: l.beneficiaryRef })),
    { type: "trailer", count: f.lines.length },
  ];
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

export function fileSha256(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

const paisa = z.string().regex(/^[1-9][0-9]{0,14}$/);
const header = z.strictObject({
  type: z.literal("header"),
  format: z.literal(PAYOUT_FORMAT),
  reference: z.string().regex(/^PTPAY-[0-9A-Z-]{4,40}$/),
  debitAccount: z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,39}$/),
  currency: z.literal("PKR"),
  totalPaisa: paisa,
  count: z.number().int().min(1).max(50_000),
});
const line = z.strictObject({
  type: z.literal("line"),
  lineNo: z.number().int().min(1),
  iban: z.string().regex(/^PK[0-9]{2}[A-Z]{4}[0-9A-Z]{16}$/),
  bankCode: z.string().regex(/^[A-Z]{4}$/),
  amountPaisa: paisa,
  beneficiaryRef: z.string().regex(/^[0-9a-f]{8}$/),
});
const trailer = z.strictObject({ type: z.literal("trailer"), count: z.number().int().min(1) });

/** Strict parser (the mock bank's side): counts, totals and line numbers must all agree. */
export function parsePayoutFile(text: string): PayoutFile {
  const rows = text.split("\n").filter((l) => l !== "");
  const h = header.parse(JSON.parse(rows[0] ?? "null"));
  const t = trailer.parse(JSON.parse(rows.at(-1) ?? "null"));
  const lines = rows.slice(1, -1).map((r) => line.parse(JSON.parse(r)));
  if (lines.length !== h.count || t.count !== h.count) throw new Error("payout file: line count does not match header and trailer");
  lines.forEach((l, i) => {
    if (l.lineNo !== i + 1) throw new Error(`payout file: line ${String(i + 1)} is numbered ${String(l.lineNo)}`);
  });
  const total = lines.reduce((s, l) => s + BigInt(l.amountPaisa), 0n);
  if (total.toString() !== h.totalPaisa) throw new Error("payout file: lines do not add up to the total");
  return {
    reference: h.reference,
    debitAccount: h.debitAccount,
    totalPaisa: BigInt(h.totalPaisa),
    lines: lines.map((l) => ({ lineNo: l.lineNo, iban: l.iban, bankCode: l.bankCode, amountPaisa: BigInt(l.amountPaisa), beneficiaryRef: l.beneficiaryRef })),
  };
}
