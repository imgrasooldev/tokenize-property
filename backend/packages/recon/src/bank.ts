import type pg from "pg";
import { z } from "zod";

/**
 * MOCK bank statement format "pt-mock-bank-v1" (until the real bank integration in Step 5g).
 * JSON Lines, UTF-8, one object per line:
 *
 *   {"type":"header","format":"pt-mock-bank-v1","account":"TRUSTEE-ESCROW-01","currency":"PKR",
 *    "statementDate":"2026-10-12","openingPaisa":"0","closingPaisa":"1500000"}
 *   {"type":"line","valueDate":"2026-10-12","amountPaisa":"1000000","reference":"RAAST-DEMO-ABCDEF012345",
 *    "counterparty":"Investor payment","balancePaisa":"1000000"}
 *   ...
 *   {"type":"trailer","lineCount":2}
 *
 * - One statement = one bank account and one PKT business day.
 * - Amounts are integer paisa written as strings (never JSON numbers, never decimals). A positive
 *   amount is money IN to the account (credit on the bank's side), negative is money OUT.
 * - balancePaisa is the running balance after the line; opening + all lines must equal closing.
 * - reference is the Raast/IBFT reference (upper-case letters, digits, dashes); it must be unique
 *   per account and direction (a refund may reuse the payment's reference in the other direction).
 * The parser is strict: unknown fields, missing trailer or a wrong line count reject the file.
 */

export const FORMAT = "pt-mock-bank-v1";
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_LINES = 100_000;

const paisa = z.string().regex(/^(0|-?[1-9][0-9]{0,17})$/, "integer paisa as a string");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), "a real date");

const header = z.strictObject({
  type: z.literal("header"),
  format: z.literal(FORMAT),
  account: z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,39}$/),
  currency: z.literal("PKR"),
  statementDate: date,
  openingPaisa: paisa,
  closingPaisa: paisa,
});
const line = z.strictObject({
  type: z.literal("line"),
  valueDate: date,
  amountPaisa: paisa.refine((v) => v !== "0", "non-zero"),
  reference: z.string().regex(/^[A-Z0-9][A-Z0-9-]{3,63}$/),
  // Printable text only: no control characters (log and terminal injection).
  counterparty: z.string().max(140).regex(/^[^\p{Cc}]*$/u),
  balancePaisa: paisa,
});
const trailer = z.strictObject({ type: z.literal("trailer"), lineCount: z.number().int().min(0).max(MAX_LINES) });

export interface StatementLine {
  valueDate: string;
  amountPaisa: bigint;
  reference: string;
  counterparty: string;
  balancePaisa: bigint;
}

export interface Statement {
  account: string;
  date: string;
  openingPaisa: bigint;
  closingPaisa: bigint;
  lines: StatementLine[];
}

export class StatementError extends Error {
  override name = "StatementError";
}

/** Parses and checks a statement file (the database checks it again on import). */
export function parseStatement(text: string): Statement {
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new StatementError(`statement larger than ${String(MAX_BYTES)} bytes`);
  const rows = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (rows.length < 2) throw new StatementError("a statement needs a header and a trailer");
  if (rows.length > MAX_LINES + 2) throw new StatementError(`more than ${String(MAX_LINES)} lines`);
  const parse = <T>(schema: z.ZodType<T>, raw: string, n: number): T => {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new StatementError(`line ${String(n)}: not JSON`);
    }
    const r = schema.safeParse(json);
    if (!r.success) throw new StatementError(`line ${String(n)}: ${r.error.issues.map((i) => `${i.path.join(".") || "line"} ${i.message}`).join("; ")}`);
    return r.data;
  };
  const h = parse(header, rows[0] ?? "", 1);
  const t = parse(trailer, rows.at(-1) ?? "", rows.length);
  const lines = rows.slice(1, -1).map((raw, i) => parse(line, raw, i + 2));
  if (t.lineCount !== lines.length) throw new StatementError(`trailer says ${String(t.lineCount)} lines, file has ${String(lines.length)}`);
  const st: Statement = {
    account: h.account,
    date: h.statementDate,
    openingPaisa: BigInt(h.openingPaisa),
    closingPaisa: BigInt(h.closingPaisa),
    lines: lines.map((l) => ({ valueDate: l.valueDate, amountPaisa: BigInt(l.amountPaisa), reference: l.reference, counterparty: l.counterparty, balancePaisa: BigInt(l.balancePaisa) })),
  };
  let running = st.openingPaisa;
  st.lines.forEach((l, i) => {
    running += l.amountPaisa;
    if (running !== l.balancePaisa) throw new StatementError(`line ${String(i + 2)}: running balance ${l.balancePaisa.toString()} should be ${running.toString()}`);
    if (l.valueDate > st.date) throw new StatementError(`line ${String(i + 2)}: value date after the statement date`);
  });
  if (running !== st.closingPaisa) throw new StatementError(`closing ${st.closingPaisa.toString()} should be opening plus lines = ${running.toString()}`);
  return st;
}

/** Writes a statement in the mock format (tests, demos). */
export function formatStatement(st: Statement): string {
  const rows: unknown[] = [
    { type: "header", format: FORMAT, account: st.account, currency: "PKR", statementDate: st.date, openingPaisa: st.openingPaisa.toString(), closingPaisa: st.closingPaisa.toString() },
    ...st.lines.map((l) => ({ type: "line", valueDate: l.valueDate, amountPaisa: l.amountPaisa.toString(), reference: l.reference, counterparty: l.counterparty, balancePaisa: l.balancePaisa.toString() })),
    { type: "trailer", lineCount: st.lines.length },
  ];
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

/** Builds a consistent statement (running balances, closing) from opening and lines. */
export function buildStatement(account: string, date: string, openingPaisa: bigint, lines: Omit<StatementLine, "balancePaisa">[]): Statement {
  let running = openingPaisa;
  const out = lines.map((l) => {
    running += l.amountPaisa;
    return { ...l, balancePaisa: running };
  });
  return { account, date, openingPaisa, closingPaisa: running, lines: out };
}

/**
 * Imports a parsed statement through recon.import_bank_statement (R-5). Returns the statement id;
 * importing the same content again returns the same id and writes nothing.
 */
export async function importStatement(db: pg.ClientBase | pg.Pool, st: Statement, actor: string): Promise<bigint> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT recon.import_bank_statement($1, $2, $3::date, $4, $5, $6::jsonb) AS id",
    [
      actor,
      st.account,
      st.date,
      st.openingPaisa.toString(),
      st.closingPaisa.toString(),
      JSON.stringify(st.lines.map((l) => ({
        valueDate: l.valueDate, amountPaisa: l.amountPaisa.toString(), reference: l.reference, counterparty: l.counterparty, balancePaisa: l.balancePaisa.toString(),
      }))),
    ],
  );
  return BigInt(rows[0]?.id ?? "0");
}
