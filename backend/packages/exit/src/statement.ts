import { buildTree, canonicalJson, keccakText, LEAF_FORMAT, rentLeaf, RATE_SCALE, SCHEDULE_KIND, STATEMENT_KIND, type Documents, type ScheduleLine } from "@pt/tax";
import type { Address } from "viem";

/**
 * The final distribution's documents (spec S-05 EX-13, section 14.3): the public statement
 * pt-rent-statement-v2 with distributionKind "final" (its keccak256 is the on-chain statementHash)
 * and the private tax schedule pt-tax-schedule-v1, in the same canonical JSON and with the same
 * Merkle leaf (wallet, net paisa) as S-03, so DistributionRegistry, /verify and @pt/tax
 * verifyDocuments work unchanged. Every holder is in the schedule (also a 0 line); only lines with a
 * positive net are entitlements (leaves).
 */
export interface FinalHeader {
  id: string;
  caseId: string;
  token: string;
  recordDate: string;
  recordBlock: string;
  incomeType: string;
  proceeds: bigint;
  inflows: bigint;
  outflows: bigint;
  distributableGross: bigint;
  wht: bigint;
  net: bigint;
  units: string;
}

export function buildFinalDocuments(h: FinalHeader, lines: readonly ScheduleLine[]): Documents {
  const sorted = [...lines].sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));
  const schedule = canonicalJson({
    kind: SCHEDULE_KIND,
    calculation: h.id,
    token: h.token,
    period: "final",
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
    distributionKind: "final",
    exitCase: h.caseId,
    calculation: h.id,
    token: h.token,
    period: "final",
    recordDate: h.recordDate,
    recordBlock: h.recordBlock,
    incomeType: h.incomeType,
    leaf: LEAF_FORMAT,
    totals: {
      proceeds: h.proceeds.toString(),
      inflows: h.inflows.toString(),
      waterfall: h.outflows.toString(),
      distributableGross: h.distributableGross.toString(),
      wht: h.wht.toString(),
      net: h.net.toString(),
      units: h.units,
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
