import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import { RATE_SCALE, withholding } from "./arithmetic.ts";
import { buildTree, rentLeaf } from "./merkle.ts";

/**
 * The rent statement (pt-rent-statement-v2, public, its keccak256 is the on-chain statementHash)
 * and the tax schedule (pt-tax-schedule-v1, private: investors' tax status; its keccak256 is in the
 * statement). Canonical JSON: keys sorted at every level, no spaces, every integer as a decimal
 * string (no JSON reader can round it). Spec S-03 OP-37/OP-38, migration 0021 OT-5.
 */
export const STATEMENT_KIND = "pt-rent-statement-v2";
export const SCHEDULE_KIND = "pt-tax-schedule-v1";
/** The leaf of S-03 OP-37: the existing DistributionRegistry leaf with the NET amount. */
export const LEAF_FORMAT = "keccak256(bytes.concat(keccak256(abi.encode(address wallet, uint256 netPaisa)))), sorted pairs";

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export function canonicalJson(v: Json): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(v)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`)
    .join(",")}}`;
}

export const keccakText = (s: string): Hex => keccak256(stringToBytes(s));

export interface CalculationHeader {
  id: string;
  token: string;
  period: string;
  recordDate: string;
  recordBlock: string;
  incomeType: string;
  collected: bigint;
  expenses: bigint;
  fees: bigint;
  reserveContribution: bigint;
  reserveRelease: bigint;
  distributableGross: bigint;
  wht: bigint;
  net: bigint;
}

export interface ScheduleLine {
  wallet: string;
  subject: string | null;
  units: string;
  gross: bigint;
  status: string;
  filerCheck: string | null;
  filerAsOf: string | null;
  flagged: boolean;
  rateId: string;
  ratePpm: number;
  wht: bigint;
  net: bigint;
}

export interface Documents {
  statement: string;
  statementHash: Hex;
  schedule: string;
  scheduleHash: Hex;
  root: Hex;
  /** Paid lines (net > 0) in leaf order with their proofs. */
  entitlements: { wallet: string; units: string; net: bigint; proof: Hex[] }[];
}

export function buildDocuments(h: CalculationHeader, lines: readonly ScheduleLine[]): Documents {
  const sorted = [...lines].sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));
  const schedule = canonicalJson({
    kind: SCHEDULE_KIND,
    calculation: h.id,
    token: h.token,
    period: h.period,
    recordDate: h.recordDate,
    incomeType: h.incomeType,
    rounding: "half-up-paisa",
    rateScale: RATE_SCALE.toString(),
    lines: sorted.map((l) => ({
      wallet: l.wallet,
      subject: l.subject,
      units: l.units,
      grossPaisa: l.gross.toString(),
      status: l.status,
      filerCheck: l.filerCheck,
      filerAsOf: l.filerAsOf,
      flagged: l.flagged,
      rateId: l.rateId,
      ratePpm: String(l.ratePpm),
      whtPaisa: l.wht.toString(),
      netPaisa: l.net.toString(),
    })),
  });
  const scheduleHash = keccakText(schedule);
  const paid = sorted.filter((l) => l.net > 0n);
  const statement = canonicalJson({
    kind: STATEMENT_KIND,
    calculation: h.id,
    token: h.token,
    period: h.period,
    recordDate: h.recordDate,
    recordBlock: h.recordBlock,
    incomeType: h.incomeType,
    leaf: LEAF_FORMAT,
    totals: {
      collected: h.collected.toString(),
      expenses: h.expenses.toString(),
      fees: h.fees.toString(),
      reserveContribution: h.reserveContribution.toString(),
      reserveRelease: h.reserveRelease.toString(),
      distributableGross: h.distributableGross.toString(),
      wht: h.wht.toString(),
      net: h.net.toString(),
    },
    entitlements: paid.map((l) => ({ wallet: l.wallet, units: l.units, netPaisa: l.net.toString() })),
    taxScheduleHash: scheduleHash,
  });
  const { root, proofs } = buildTree(paid.map((l) => rentLeaf(l.wallet as Address, l.net)));
  return {
    statement,
    statementHash: keccakText(statement),
    schedule,
    scheduleHash,
    root,
    entitlements: paid.map((l, i) => ({ wallet: l.wallet, units: l.units, net: l.net, proof: proofs.at(i) ?? [] })),
  };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * An independent check of stored documents (reconciliation, trustee recomputation): hashes,
 * the Merkle root from the statement's own entitlements, totals, and per line gross = net + WHT
 * with the rounding rule. Returns the problems found (empty = consistent).
 */
export function verifyDocuments(d: { statement: string; statementHash: string; schedule: string; scheduleHash: string; root: string }): string[] {
  const problems: string[] = [];
  if (keccakText(d.statement) !== d.statementHash.toLowerCase()) problems.push("statement does not hash to its statement hash");
  if (keccakText(d.schedule) !== d.scheduleHash.toLowerCase()) problems.push("tax schedule does not hash to its hash");
  let s: Record<string, unknown>;
  let t: Record<string, unknown>;
  try {
    s = JSON.parse(d.statement) as Record<string, unknown>;
    t = JSON.parse(d.schedule) as Record<string, unknown>;
  } catch {
    return [...problems, "statement or tax schedule is not JSON"];
  }
  if (s.kind !== STATEMENT_KIND || t.kind !== SCHEDULE_KIND) problems.push("unknown statement or schedule kind");
  if (str(s.taxScheduleHash) !== d.scheduleHash.toLowerCase()) problems.push("statement names another tax schedule");
  const totals = (s.totals ?? {}) as Record<string, unknown>;
  const ents = Array.isArray(s.entitlements) ? (s.entitlements as Record<string, unknown>[]) : [];
  const lines = Array.isArray(t.lines) ? (t.lines as Record<string, unknown>[]) : [];
  try {
    const big = (v: unknown): bigint => BigInt(str(v));
    const net = ents.reduce((a, e) => a + big(e.netPaisa), 0n);
    if (net !== big(totals.net)) problems.push(`entitlements sum to ${net.toString()} paisa, totals say ${str(totals.net)}`);
    if (big(totals.distributableGross) !== big(totals.wht) + big(totals.net)) problems.push("distributable gross differs from WHT + net");
    let g = 0n;
    let w = 0n;
    for (const l of lines) {
      const gross = big(l.grossPaisa);
      const wht = big(l.whtPaisa);
      const n = big(l.netPaisa);
      g += gross;
      w += wht;
      if (gross !== n + wht) problems.push(`line ${str(l.wallet)}: gross ${gross.toString()} differs from net + WHT`);
      if (wht !== withholding(gross, big(l.ratePpm))) problems.push(`line ${str(l.wallet)}: WHT ${wht.toString()} does not follow the rounding rule`);
      const e = ents.find((x) => x.wallet === l.wallet);
      if ((n > 0n ? big(e?.netPaisa) : 0n) !== n) problems.push(`line ${str(l.wallet)}: entitlement differs from the schedule's net`);
    }
    if (g !== big(totals.distributableGross)) problems.push("schedule lines do not sum to the distributable gross");
    if (w !== big(totals.wht)) problems.push("schedule WHT does not sum to the statement's WHT");
    if (ents.length > 0) {
      const { root } = buildTree(ents.map((e) => rentLeaf(str(e.wallet) as Address, big(e.netPaisa))));
      if (root !== d.root.toLowerCase()) problems.push("Merkle root differs from the statement's entitlements");
    }
  } catch {
    problems.push("malformed amounts in the statement or the tax schedule");
  }
  return problems;
}
