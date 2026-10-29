/**
 * Reads a bank statement file in the mock format "pt-mock-bank-v1" (JSON Lines: header, lines,
 * trailer; amounts as integer paisa strings) for the portal's import (migration 0037). It only
 * extracts what the database needs; recon.import_bank_statement checks every rule again, so this
 * stays a thin reader that refuses obviously broken files with a readable message.
 */
export interface ParsedStatement {
  account: string;
  date: string;
  openingPaisa: string;
  closingPaisa: string;
  lines: { valueDate: string; amountPaisa: string; reference: string; counterparty: string; balancePaisa: string }[];
}

const PAISA = /^(0|-?[1-9][0-9]{0,17})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function obj(raw: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function parseBankStatement(text: string): ParsedStatement | string {
  const rows = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (rows.length < 2) return "A statement needs a header and a trailer line.";
  if (rows.length > 100_002) return "More than 100,000 lines.";
  const h = obj(rows[0] ?? "");
  if (h?.type !== "header" || h.format !== "pt-mock-bank-v1" || h.currency !== "PKR") return "Line 1 is not a pt-mock-bank-v1 PKR header.";
  if (!DATE.test(str(h.statementDate)) || !PAISA.test(str(h.openingPaisa)) || !PAISA.test(str(h.closingPaisa))) return "The header's date or balances are malformed.";
  const t = obj(rows.at(-1) ?? "");
  if (t?.type !== "trailer" || typeof t.lineCount !== "number") return "The last line is not a trailer.";
  const lines: ParsedStatement["lines"] = [];
  for (const [i, raw] of rows.slice(1, -1).entries()) {
    const l = obj(raw);
    if (l?.type !== "line") return `Line ${String(i + 2)} is not a statement line.`;
    lines.push({ valueDate: str(l.valueDate), amountPaisa: str(l.amountPaisa), reference: str(l.reference), counterparty: str(l.counterparty), balancePaisa: str(l.balancePaisa) });
  }
  if (t.lineCount !== lines.length) return `The trailer says ${String(t.lineCount)} lines; the file has ${String(lines.length)}.`;
  return { account: str(h.account), date: str(h.statementDate), openingPaisa: str(h.openingPaisa), closingPaisa: str(h.closingPaisa), lines };
}
