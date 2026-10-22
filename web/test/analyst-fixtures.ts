import type { Catalog, CatalogEntry } from "../src/lib/server/catalog";
import type { PublicOffering } from "../src/lib/server/offerings";
import { computeScore } from "../src/lib/score";

/** Hand-made catalogue entries for analyst and search unit tests (no database). */

const AT = "2026-10-13T09:00:00.000Z";
const SHA_A = `0x${"a1".repeat(32)}` as const;
const SHA_B = `0x${"b2".repeat(32)}` as const;
export const OFFERING_ID = "3f2b8c1e-0d4a-4b7e-9c11-2a6f0e5d7b90";

export function tokenEntry(): CatalogEntry {
  const dists = [
    { id: 3n, status: "paid" as const, recordBlock: 9120n, publishedAt: new Date("2026-09-30T10:00:00Z"), root: SHA_A, totalPaisa: 2_500_000n, statementHash: SHA_B, rejectReason: null, payoutBatchHash: null, updatedBlock: 9130n, updatedAt: null },
    { id: 2n, status: "finalized" as const, recordBlock: 8120n, publishedAt: new Date("2026-08-31T10:00:00Z"), root: SHA_A, totalPaisa: 2_450_050n, statementHash: SHA_B, rejectReason: null, payoutBatchHash: null, updatedBlock: 8130n, updatedAt: null },
  ];
  return {
    key: "GPF3",
    href: "/properties/GPF3",
    symbol: "GPF3",
    name: { en: "Gulberg Plaza, Floor 3", ur: "گلبرگ پلازہ، تیسری منزل" },
    city: { en: "Lahore", ur: "لاہور" },
    province: "punjab",
    district: "Lahore",
    use: "commercial",
    status: "live",
    issuePricePaisa: 50_000n,
    listed: null,
    token: { address: "0x00000000000000000000000000000000000000aa", supply: 60_000n, cap: 100_000n, paused: false, pauseReason: null, symbol: "GPF3", asOfBlock: 9876n },
    offering: null,
    facts: null,
    documents: [],
    chainDocuments: [{ id: 1n, docType: 0, sha256: SHA_A, uri: "pt-doc://1", supersededBy: null, addedBlock: 120n, addedAt: new Date("2026-01-05T00:00:00Z") }],
    distributions: dists,
    yield: { rentPaisa12m: 4_950_050n, yieldBp: 165, months: 2, supply: 60_000n },
    holders: 7,
    topHolderBp: 4_166,
    lastPricePaisa: 51_250n,
    score: computeScore({ occupancy: null, leaseMonthsRemaining: null, rentMonthsLast12: 2, documentClasses: { title: true, valuation: false, trust: false, insurance: false }, reconciliation: "passed", topHolderBp: 4_166 }),
    art: "tower",
  };
}

export function offeringEntry(): CatalogEntry {
  const o: PublicOffering = {
    offeringId: OFFERING_ID,
    state: "live",
    token: null,
    pricePaisa: 100_000n,
    minRaiseUnits: 1_000n,
    targetUnits: 5_000n,
    hardCapUnits: 6_000n,
    minUnits: 10n,
    maxUnits: 500n,
    maxHoldingUnits: null,
    opensAt: "2026-10-01T05:00:00.000Z",
    closesAt: "2026-11-01T05:00:00.000Z",
    extended: false,
    paymentGraceMinutes: 30,
    reservationMinutes: 60,
    completionDays: 45,
    completionDeadline: null,
    earlyClose: false,
    allOrNothing: true,
    categories: [],
    useOfProceeds: [
      { line: "purchase_price", paisa: 450_000_000n },
      { line: "platform_fee", paisa: 7_500_000n },
    ],
    docEnSha: SHA_B,
    docUrSha: null,
    riskSha: null,
    paidUnits: 1_200n,
    heldUnits: 100n,
    availableUnits: 3_700n,
    waitlistedUnits: 0n,
    withdrawalUntil: null,
    fundedAt: null,
    completedAt: null,
    failedAt: null,
    province: "sindh",
    district: "Karachi South",
    use: "residential",
    coveredAreaSqft: "12000",
  };
  return {
    key: OFFERING_ID,
    href: `/properties/${OFFERING_ID}`,
    symbol: null,
    name: { en: "Clifton Residency", ur: "کلفٹن ریزیڈنسی" },
    city: { en: "Karachi South", ur: "Karachi South" },
    province: "sindh",
    district: "Karachi South",
    use: "residential",
    status: "open",
    issuePricePaisa: 100_000n,
    listed: null,
    token: null,
    offering: o,
    facts: {
      building: "Clifton Residency",
      coveredAreaSqft: "12000",
      built: true,
      occupancy: "tenanted",
      leaseCount: 4,
      monthlyRentPaisa: 3_000_000n,
      structureKind: "spv",
      shariah: null,
      plannedUnits: "6000",
      maxHoldingUnits: null,
      trusteeAcceptedAt: "2026-09-15T07:00:00.000Z",
      sponsorKybApproved: true,
      valuations: 2,
      valuationLowPaisa: 440_000_000n,
      valuationHighPaisa: 470_000_000n,
      valuedOn: "2026-09-01",
    },
    documents: [{ docType: "title_deed", chainDocType: "0", sha256: SHA_A, uploadedAt: "2026-09-02T00:00:00.000Z", verified: true }],
    chainDocuments: null,
    distributions: null,
    yield: null,
    holders: null,
    topHolderBp: null,
    lastPricePaisa: null,
    score: computeScore({ occupancy: "tenanted", leaseMonthsRemaining: null, rentMonthsLast12: null, documentClasses: { title: true, valuation: false, trust: false, insurance: false }, reconciliation: "passed", topHolderBp: null }),
    art: "office",
  };
}

export function fixtureCatalog(): Catalog {
  return {
    at: AT,
    block: "9876",
    recon: { status: "passed", finishedAt: "2026-10-13T08:00:00.000Z", pinnedBlock: "9870", blocking: 0, warnings: 1, payoutsAllowed: true },
    entries: [tokenEntry(), offeringEntry()],
  };
}
