import { describe, expect, it } from "vitest";
import { matches, parseFilters, percentToBp, queryOf, sortEntries, type Filterable } from "../src/lib/catalog-filter";
import { catalogDict } from "../src/lib/i18n-catalog";
import {
  computeScore,
  concentrationPoints,
  documentPoints,
  leasePoints,
  occupancyPoints,
  reconciliationPoints,
  rentRecordPoints,
  SCORE_WEIGHTS,
} from "../src/lib/score";
import { documentClasses, offeringStatus, placeOf, rentByMonth, trailingYield } from "../src/lib/server/catalog";
import { maskedIban, payeeState } from "../src/lib/server/payees";

describe("property score (rule-based, T-045)", () => {
  it("weights add up to 100", () => {
    expect(Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("scores each factor by its published rule", () => {
    expect([occupancyPoints("tenanted"), occupancyPoints("partly_tenanted"), occupancyPoints("owner_occupied"), occupancyPoints("vacant"), occupancyPoints(null)]).toEqual([100, 60, 40, 0, null]);
    expect([leasePoints(0), leasePoints(18), leasePoints(36), leasePoints(120), leasePoints(null)]).toEqual([0, 50, 100, 100, null]);
    expect([rentRecordPoints(0), rentRecordPoints(6), rentRecordPoints(12), rentRecordPoints(30), rentRecordPoints(null)]).toEqual([0, 50, 100, 100, null]);
    expect(documentPoints({ title: true, valuation: true, trust: false, insurance: false })).toBe(50);
    expect(documentPoints(null)).toBeNull();
    expect([reconciliationPoints("passed"), reconciliationPoints("failed"), reconciliationPoints(null)]).toEqual([100, 0, null]);
    expect([concentrationPoints(500), concentrationPoints(1_000), concentrationPoints(3_000), concentrationPoints(5_000), concentrationPoints(9_000), concentrationPoints(null)]).toEqual([
      100, 100, 50, 0, 0, null,
    ]);
  });

  it("re-normalises over the factors with data, rounding half up with integers", () => {
    // rent 100 x 20, documents 50 x 15, recon 100 x 15, concentration 50 x 15 = 2000+750+1500+750 = 5000 over 65 → 76.92 → 77
    const s = computeScore({
      occupancy: null,
      leaseMonthsRemaining: null,
      rentMonthsLast12: 12,
      documentClasses: { title: true, valuation: true, trust: false, insurance: false },
      reconciliation: "passed",
      topHolderBp: 3_000,
    });
    expect(s.coverage).toBe(65);
    expect(s.score).toBe(77);
    expect(s.factors.map((f) => f.points)).toEqual([null, null, 100, 50, 100, 50]);
  });

  it("gives no score below 50 % coverage, and 100 / 0 at the extremes", () => {
    expect(computeScore({ occupancy: "tenanted", leaseMonthsRemaining: null, rentMonthsLast12: null, documentClasses: null, reconciliation: "passed", topHolderBp: null }).score).toBeNull();
    const all = { occupancy: "tenanted" as const, leaseMonthsRemaining: 48, rentMonthsLast12: 12, documentClasses: { title: true, valuation: true, trust: true, insurance: true }, reconciliation: "passed" as const, topHolderBp: 100 };
    expect(computeScore(all).score).toBe(100);
    expect(computeScore({ ...all, occupancy: "vacant", leaseMonthsRemaining: 0, rentMonthsLast12: 0, documentClasses: { title: false, valuation: false, trust: false, insurance: false }, reconciliation: "failed", topHolderBp: 9_000 }).score).toBe(0);
  });
});

describe("catalogue figures from records", () => {
  const now = new Date("2026-10-13T12:00:00Z");
  const d = (iso: string, paisa: bigint, status: "published" | "rejected" | "finalized" | "paid" = "paid") => ({ status, publishedAt: new Date(iso), totalPaisa: paisa });

  it("trailing yield: last 365 days, rejected excluded, integer basis points", () => {
    const dists = [d("2026-09-01T00:00:00Z", 2_000_000_000n), d("2026-08-01T00:00:00Z", 2_000_000_000n), d("2026-07-01T00:00:00Z", 9_999n, "rejected"), d("2025-01-01T00:00:00Z", 5n)];
    // 40,000,000.00 PKR? no: 4,000,000,000 paisa over 1,000,000 tokens at 50,000 paisa = 4e9*1e4/(1e6*5e4) = 800 bp
    const y = trailingYield(dists, 1_000_000n, 50_000n, now);
    expect(y.rentPaisa12m).toBe(4_000_000_000n);
    expect(y.yieldBp).toBe(800);
    expect(y.months).toBe(2);
    expect(trailingYield(dists, 0n, 50_000n, now).yieldBp).toBeNull();
    expect(trailingYield([], 10n, null, now).yieldBp).toBeNull();
  });

  it("rent per PKT month: a distribution at 20:00 UTC on the 31st belongs to the next month in Pakistan", () => {
    expect(rentByMonth([d("2026-08-31T20:00:00Z", 100n), d("2026-09-02T00:00:00Z", 50n), d("2026-09-03T00:00:00Z", 7n, "rejected")])).toEqual([{ month: "2026-09-01", paisa: 150n }]);
  });

  it("document classes from chain types or published file types", () => {
    expect(documentClasses([0, 2], [])).toEqual({ title: true, valuation: true, trust: false, insurance: false });
    expect(documentClasses([], ["trust_deed", "insurance_policy"])).toEqual({ title: false, valuation: false, trust: true, insurance: true });
  });

  it("offering states map to list statuses; places fall back to the province", () => {
    expect([offeringStatus("live"), offeringStatus("ready"), offeringStatus("completed")]).toEqual(["open", "soon", "closed"]);
    expect(placeOf("punjab", "Lahore")).toEqual({ lat: 31.52, lon: 74.36 });
    expect(placeOf("sindh", "Unknown District")).toEqual({ lat: 25.89, lon: 68.52 });
    expect(placeOf(null, null)).toBeNull();
  });
});

describe("property list filters (URL query)", () => {
  const e = (over: Partial<Filterable>): Filterable => ({
    key: "K",
    name: { en: "N", ur: "N" },
    status: "live",
    use: "commercial",
    province: "punjab",
    district: "Lahore",
    occupancy: null,
    yieldBp: null,
    issuePricePaisa: 50_000n,
    score: null,
    ...over,
  });

  it("parses only known values", () => {
    expect(parseFilters({ f: "soon", use: "residential", place: "Lahore", occ: "vacant", minYield: "8.5", sort: "yield" })).toEqual({
      tab: "soon",
      use: "residential",
      place: "lahore",
      occupancy: "vacant",
      minYieldBp: 850,
      sort: "yield",
    });
    expect(parseFilters({ f: "x", use: "castle", place: "<script>", occ: "x", minYield: "abc", sort: "x" })).toEqual({
      tab: "all",
      use: null,
      place: null,
      occupancy: null,
      minYieldBp: null,
      sort: "score",
    });
    expect([percentToBp("8"), percentToBp("8.25"), percentToBp("101"), percentToBp("1.234"), percentToBp("")]).toEqual([800, 825, null, null, null]);
  });

  it("filters by tab, use, place, occupancy and minimum yield", () => {
    const f = parseFilters({});
    expect(matches(e({}), f)).toBe(true);
    expect(matches(e({ status: "soon" }), { ...f, tab: "live" })).toBe(false);
    expect(matches(e({ status: "open" }), { ...f, tab: "live" })).toBe(true);
    expect(matches(e({ status: "soon" }), { ...f, tab: "soon" })).toBe(true);
    expect(matches(e({}), { ...f, use: "residential" })).toBe(false);
    expect(matches(e({}), { ...f, place: "punjab" })).toBe(true);
    expect(matches(e({}), { ...f, place: "lahore" })).toBe(true);
    expect(matches(e({}), { ...f, place: "sindh" })).toBe(false);
    expect(matches(e({}), { ...f, occupancy: "tenanted" })).toBe(false);
    expect(matches(e({ yieldBp: null }), { ...f, minYieldBp: 100 })).toBe(false);
    expect(matches(e({ yieldBp: 900 }), { ...f, minYieldBp: 850 })).toBe(true);
  });

  it("sorts with unknown values last and stable ties", () => {
    const list = [e({ key: "a", name: { en: "B", ur: "B" }, score: null, yieldBp: 100 }), e({ key: "b", name: { en: "A", ur: "A" }, score: 70, yieldBp: null }), e({ key: "c", name: { en: "C", ur: "C" }, score: 90, issuePricePaisa: null })];
    expect(sortEntries(list, "score").map((x) => x.key)).toEqual(["c", "b", "a"]);
    expect(sortEntries(list, "yield").map((x) => x.key)).toEqual(["a", "b", "c"]);
    expect(sortEntries(list, "price").map((x) => x.key)).toEqual(["b", "a", "c"]);
    expect(sortEntries(list, "name").map((x) => x.key)).toEqual(["b", "a", "c"]);
    expect(queryOf({ f: "soon", use: null, sort: "" })).toBe("?f=soon");
    expect(queryOf({})).toBe("");
  });
});

describe("payout accounts (display)", () => {
  it("shows only the last four digits and derives the cooling-off state", () => {
    expect(maskedIban("4321")).toBe("PK•• •••• •••• •••• •••• 4321");
    expect(maskedIban("12ab")).toContain("••••");
    const now = Date.parse("2026-10-13T00:00:00Z");
    expect(payeeState({ activeFrom: "2026-10-14T00:00:00Z", supersededAt: null }, now)).toBe("cooling");
    expect(payeeState({ activeFrom: "2026-10-12T00:00:00Z", supersededAt: null }, now)).toBe("active");
    expect(payeeState({ activeFrom: "2026-10-12T00:00:00Z", supersededAt: "2026-10-12T10:00:00Z" }, now)).toBe("replaced");
  });

  it("has the same keys in English and Urdu", () => {
    expect(Object.keys(catalogDict("ur")).sort()).toEqual(Object.keys(catalogDict("en")).sort());
  });
});
