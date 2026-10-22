/**
 * Property score (T-045): a transparent, rule-based number from published inputs only. It is not a
 * prediction, not a rating by a licensed agency and never a recommendation to buy or sell. Every
 * factor, its weight and its input are shown next to the number ("How this is calculated").
 *
 * Integer arithmetic only. A factor whose input is not published is left out and the remaining
 * weights are re-normalised; when less than half of the weight has data, there is no score.
 */

export type ScoreFactorKey = "occupancy" | "lease" | "rentRecord" | "documents" | "reconciliation" | "concentration";

/** Weights in points out of 100 (sum = 100). Changing them is a documented decision (ADR 0015). */
export const SCORE_WEIGHTS: Record<ScoreFactorKey, number> = {
  occupancy: 20,
  lease: 15,
  rentRecord: 20,
  documents: 15,
  reconciliation: 15,
  concentration: 15,
};

export const SCORE_ORDER: ScoreFactorKey[] = ["occupancy", "lease", "rentRecord", "documents", "reconciliation", "concentration"];

/** Minimum share of the total weight (percent) that must have data for a score to be shown. */
export const MIN_COVERAGE = 50;

export type Occupancy = "vacant" | "owner_occupied" | "tenanted" | "partly_tenanted";

export interface ScoreInputs {
  /** S-01 occupancy as declared and reviewed in due diligence; null = not published. */
  occupancy: Occupancy | null;
  /** Months of lease term remaining, weighted by rent; null = not published (no lease register yet). */
  leaseMonthsRemaining: number | null;
  /** Rent distributions (not rejected) in the last 12 months, by distinct calendar month (0..12); null = no token yet. */
  rentMonthsLast12: number | null;
  /** Which of the four key document classes are anchored/published: title, valuation, trust deed, insurance. */
  documentClasses: { title: boolean; valuation: boolean; trust: boolean; insurance: boolean } | null;
  /** Latest finished reconciliation run; null = no run visible. */
  reconciliation: "passed" | "failed" | null;
  /** Largest single holder's share of the issued supply in basis points (0..10000); null = nothing issued. */
  topHolderBp: number | null;
}

export interface ScoreFactor {
  key: ScoreFactorKey;
  weight: number;
  /** 0..100, or null when the input is not published (factor left out). */
  points: number | null;
}

export interface PropertyScore {
  /** 0..100, or null when coverage is below MIN_COVERAGE. */
  score: number | null;
  /** Percent of the total weight that had data (0..100). */
  coverage: number;
  factors: ScoreFactor[];
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

export function occupancyPoints(o: Occupancy | null): number | null {
  switch (o) {
    case "tenanted":
      return 100;
    case "partly_tenanted":
      return 60;
    case "owner_occupied":
      return 40;
    case "vacant":
      return 0;
    default:
      return null;
  }
}

/** 36 months or more remaining = 100; linear below. */
export function leasePoints(months: number | null): number | null {
  if (months === null || !Number.isFinite(months)) return null;
  return clamp(Math.floor((Math.max(0, Math.floor(months)) * 100) / 36), 0, 100);
}

/** One distribution in each of the last 12 months = 100. */
export function rentRecordPoints(months: number | null): number | null {
  if (months === null || !Number.isFinite(months)) return null;
  return clamp(Math.floor((clamp(Math.floor(months), 0, 12) * 100) / 12), 0, 100);
}

/** 25 points per key document class published. */
export function documentPoints(d: ScoreInputs["documentClasses"]): number | null {
  if (d === null) return null;
  return [d.title, d.valuation, d.trust, d.insurance].filter(Boolean).length * 25;
}

export function reconciliationPoints(r: ScoreInputs["reconciliation"]): number | null {
  if (r === null) return null;
  return r === "passed" ? 100 : 0;
}

/** Top holder at or below 10 % of supply = 100, at or above 50 % = 0, linear between. */
export function concentrationPoints(bp: number | null): number | null {
  if (bp === null || !Number.isFinite(bp)) return null;
  const b = clamp(Math.floor(bp), 0, 10_000);
  if (b <= 1_000) return 100;
  if (b >= 5_000) return 0;
  return Math.floor(((5_000 - b) * 100) / 4_000);
}

export function computeScore(i: ScoreInputs): PropertyScore {
  const points = new Map<ScoreFactorKey, number | null>([
    ["occupancy", occupancyPoints(i.occupancy)],
    ["lease", leasePoints(i.leaseMonthsRemaining)],
    ["rentRecord", rentRecordPoints(i.rentMonthsLast12)],
    ["documents", documentPoints(i.documentClasses)],
    ["reconciliation", reconciliationPoints(i.reconciliation)],
    ["concentration", concentrationPoints(i.topHolderBp)],
  ]);
  const weights = new Map(Object.entries(SCORE_WEIGHTS));
  const factors = SCORE_ORDER.map((key) => ({ key, weight: weights.get(key) ?? 0, points: points.get(key) ?? null }));
  let known = 0;
  let weighted = 0;
  for (const f of factors) {
    if (f.points === null) continue;
    known += f.weight;
    weighted += f.points * f.weight;
  }
  const coverage = known; // weights sum to 100, so known weight = percent
  // Round half up with integers: (2 * weighted + known) / (2 * known).
  const score = known === 0 || coverage < MIN_COVERAGE ? null : Math.floor((2 * weighted + known) / (2 * known));
  return { score, coverage, factors };
}
