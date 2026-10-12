import { describe, expect, it } from "vitest";
import { buildStatement, formatStatement, parseStatement, StatementError } from "../src/bank.ts";

/** The mock bank statement format pt-mock-bank-v1: strict parsing before anything reaches the database. */

const good = buildStatement("TRUSTEE-ESCROW-01", "2026-10-12", 1_000n, [
  { valueDate: "2026-10-12", amountPaisa: 250_000n, reference: "RAAST-DEMO-ABCDEF012345", counterparty: "Investor payment" },
  { valueDate: "2026-10-11", amountPaisa: -50_000n, reference: "RAAST-DEMO-ABCDEF012345", counterparty: "Refund" },
]);
const text = formatStatement(good);
const rows = (): Record<string, unknown>[] => text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
const write = (r: Record<string, unknown>[]): string => r.map((x) => JSON.stringify(x)).join("\n");

describe("mock bank statement", () => {
  it("round-trips and computes running balances", () => {
    expect(parseStatement(text)).toEqual(good);
    expect(good.closingPaisa).toBe(201_000n);
    expect(good.lines.map((l) => l.balancePaisa)).toEqual([251_000n, 201_000n]);
    expect(parseStatement(text.replace(/\n/g, "\r\n"))).toEqual(good);
  });

  it.each([
    ["no trailer", (r: Record<string, unknown>[]) => r.slice(0, -1)],
    ["wrong line count", (r: Record<string, unknown>[]) => [...r.slice(0, -1), { type: "trailer", lineCount: 5 }]],
    ["unknown field", (r: Record<string, unknown>[]) => r.map((x, i) => (i === 1 ? { ...x, note: "extra" } : x))],
    ["amount as a JSON number", (r: Record<string, unknown>[]) => r.map((x, i) => (i === 1 ? { ...x, amountPaisa: 250000 } : x))],
    ["decimal amount", (r: Record<string, unknown>[]) => r.map((x, i) => (i === 1 ? { ...x, amountPaisa: "2500.00" } : x))],
    ["zero amount", (r: Record<string, unknown>[]) => r.map((x, i) => (i === 1 ? { ...x, amountPaisa: "0" } : x))],
    ["other currency", (r: Record<string, unknown>[]) => r.map((x, i) => (i === 0 ? { ...x, currency: "USD" } : x))],
    ["other format", (r: Record<string, unknown>[]) => r.map((x, i) => (i === 0 ? { ...x, format: "pt-mock-bank-v2" } : x))],
    ["impossible date", (r: Record<string, unknown>[]) => r.map((x, i) => (i === 0 ? { ...x, statementDate: "2026-02-30" } : x))],
    ["lower-case reference", (r: Record<string, unknown>[]) => r.map((x, i) => (i === 1 ? { ...x, reference: "raast-1234" } : x))],
    ["control character in counterparty", (r: Record<string, unknown>[]) => r.map((x, i) => (i === 1 ? { ...x, counterparty: "evil\u001b[2J" } : x))],
    ["running balance off by one", (r: Record<string, unknown>[]) => r.map((x, i) => (i === 1 ? { ...x, balancePaisa: "251001" } : x))],
    ["closing does not add up", (r: Record<string, unknown>[]) => r.map((x, i) => (i === 0 ? { ...x, closingPaisa: "1" } : x))],
    ["value date after the statement date", (r: Record<string, unknown>[]) => r.map((x, i) => (i === 1 ? { ...x, valueDate: "2026-10-13" } : x))],
    ["header not first", (r: Record<string, unknown>[]) => [r[1] ?? {}, r[0] ?? {}, ...r.slice(2)]],
  ])("rejects %s", (_name, edit) => {
    expect(() => parseStatement(write(edit(rows())))).toThrow(StatementError);
  });

  it("rejects text that is not JSON lines", () => {
    expect(() => parseStatement("date,amount\n2026-10-12,100\n")).toThrow(/not JSON/);
  });
});
