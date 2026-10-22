import { PROPERTIES, type Property, type PropertyUse } from "../properties";
import { computeScore, type Occupancy, type PropertyScore } from "../score";
import { db } from "./db";
import { listOfferings, type PublicOffering } from "./offerings";
import { distributionsOfToken, documentsOfToken, indexStatus, liveToken, registerFigures, type DistributionRow, type DocumentRow, type LiveToken } from "./readmodel";

/**
 * The public property catalogue (T-045): every property the website lists, built from records only.
 *   - Listed tokens (lib/properties.ts) with the chain read model: supply, cap, pause, holders, rent
 *     distributions, DocumentRegistry records.
 *   - Offerings investors may see (offering.web_offerings, WO-5) with their property's public facts
 *     (property.web_catalog, migration 0022 WA-3) and published document hashes (WA-4).
 *   - The latest reconciliation status (recon.web_status, WA-5).
 * Nothing is estimated: a figure without a record is null and the page says "not published".
 */

export type CatalogStatus = "live" | "open" | "soon" | "closed" | "unavailable";

export interface PropertyFacts {
  building: string | null;
  coveredAreaSqft: string | null;
  built: boolean | null;
  occupancy: Occupancy | null;
  leaseCount: number | null;
  monthlyRentPaisa: bigint | null;
  structureKind: "reit" | "spv" | null;
  shariah: boolean | null;
  plannedUnits: string | null;
  maxHoldingUnits: string | null;
  trusteeAcceptedAt: string | null;
  sponsorKybApproved: boolean;
  valuations: number;
  valuationLowPaisa: bigint | null;
  valuationHighPaisa: bigint | null;
  valuedOn: string | null;
}

export interface PublishedDocument {
  docType: string;
  chainDocType: string;
  sha256: string;
  uploadedAt: string;
  verified: boolean;
}

export interface TrailingYield {
  /** Distributed rent (not rejected) in the last 365 days, paisa. */
  rentPaisa12m: bigint;
  /** Annual rent per issued token ÷ issue price, in basis points (integer); null when nothing issued. */
  yieldBp: number | null;
  /** Distinct calendar months (PKT) with a distribution in the last 12 months. */
  months: number;
  supply: bigint;
}

export interface CatalogEntry {
  /** URL key: the token symbol, or the offering id for an offering without a listed token. */
  key: string;
  href: string;
  symbol: string | null;
  name: { en: string; ur: string };
  city: { en: string; ur: string } | null;
  province: string | null;
  district: string | null;
  use: PropertyUse | null;
  status: CatalogStatus;
  /** Issue price per unit in paisa (listed token price, or the offering price). */
  issuePricePaisa: bigint | null;
  listed: Property | null;
  token: LiveToken | null;
  offering: PublicOffering | null;
  facts: PropertyFacts | null;
  documents: PublishedDocument[];
  chainDocuments: DocumentRow[] | null;
  distributions: DistributionRow[] | null;
  yield: TrailingYield | null;
  holders: number | null;
  topHolderBp: number | null;
  lastPricePaisa: bigint | null;
  score: PropertyScore;
  art: Property["art"];
}

export interface ReconSummary {
  status: "passed" | "failed";
  finishedAt: string;
  pinnedBlock: string | null;
  blocking: number;
  warnings: number;
  payoutsAllowed: boolean | null;
}

export interface Catalog {
  at: string;
  /** Read model block the chain figures are from (null when unavailable). */
  block: string | null;
  recon: ReconSummary | null;
  entries: CatalogEntry[];
}

// ------------------------------------------------------------------ places
/** Pakistan provinces and territories as stored in property.properties.province (S-01). */
export const PROVINCES = ["punjab", "sindh", "kp", "balochistan", "ict", "gb", "ajk"] as const;

const PROVINCE_CENTRE: Record<string, [number, number]> = {
  punjab: [31.17, 72.7],
  sindh: [25.89, 68.52],
  kp: [34.95, 72.33],
  balochistan: [28.49, 65.1],
  ict: [33.68, 73.05],
  gb: [35.8, 74.98],
  ajk: [33.93, 73.78],
};

/** Approximate centres (lat, lon) of districts that commonly appear; others fall back to the province. */
const DISTRICT_CENTRE: Record<string, [number, number]> = {
  lahore: [31.52, 74.36],
  karachi: [24.86, 67.01],
  "karachi south": [24.85, 67.02],
  "karachi east": [24.9, 67.1],
  "karachi central": [24.93, 67.04],
  "karachi west": [24.92, 66.98],
  korangi: [24.83, 67.13],
  malir: [24.95, 67.2],
  islamabad: [33.68, 73.05],
  rawalpindi: [33.6, 73.04],
  faisalabad: [31.42, 73.08],
  multan: [30.2, 71.47],
  gujranwala: [32.16, 74.19],
  sialkot: [32.49, 74.53],
  peshawar: [34.01, 71.58],
  quetta: [30.18, 66.98],
  hyderabad: [25.4, 68.37],
  sukkur: [27.7, 68.86],
  abbottabad: [34.15, 73.21],
  bahawalpur: [29.4, 71.68],
  sargodha: [32.08, 72.67],
  gilgit: [35.92, 74.31],
  muzaffarabad: [34.37, 73.47],
  gwadar: [25.13, 62.32],
};

export function placeOf(province: string | null, district: string | null): { lat: number; lon: number } | null {
  const d = district ? new Map(Object.entries(DISTRICT_CENTRE)).get(district.trim().toLowerCase()) : undefined;
  const p = province ? new Map(Object.entries(PROVINCE_CENTRE)).get(province) : undefined;
  const c = d ?? p;
  return c ? { lat: c[0], lon: c[1] } : null;
}

// ------------------------------------------------------------------ pure helpers (unit-tested)
const DAY_MS = 86_400_000;
const PKT_MS = 5 * 3_600_000;

/** Trailing 12-month distributed rent and yield on the issue price, integer arithmetic only. */
export function trailingYield(dists: Pick<DistributionRow, "status" | "publishedAt" | "totalPaisa">[], supply: bigint, issuePricePaisa: bigint | null, now: Date): TrailingYield {
  const since = now.getTime() - 365 * DAY_MS;
  let rent = 0n;
  const months = new Set<string>();
  for (const d of dists) {
    if (d.status === "rejected" || d.publishedAt.getTime() < since || d.publishedAt.getTime() > now.getTime()) continue;
    rent += d.totalPaisa;
    const pkt = new Date(d.publishedAt.getTime() + PKT_MS);
    months.add(`${String(pkt.getUTCFullYear())}-${String(pkt.getUTCMonth())}`);
  }
  // yield (bp) = rent / supply / price * 10000 = rent * 10000 / (supply * price), rounded down.
  const yieldBp = supply > 0n && issuePricePaisa !== null && issuePricePaisa > 0n ? Number((rent * 10_000n) / (supply * issuePricePaisa)) : null;
  return { rentPaisa12m: rent, yieldBp, months: months.size, supply };
}

/** Key document classes present among DocumentRegistry records (current only) or published hashes. */
export function documentClasses(chainTypes: number[], published: string[]): { title: boolean; valuation: boolean; trust: boolean; insurance: boolean } {
  // DocumentRegistry.DocType: 0 TitleDeed, 1 LandRecord, 2 Valuation, 3 Insurance, 4 TrustDeed.
  const has = (n: number[], codes: string[]): boolean => chainTypes.some((x) => n.includes(x)) || published.some((x) => codes.includes(x));
  return {
    title: has([0, 1], ["title_deed", "land_record_extract"]),
    valuation: has([2], ["valuation_report"]),
    trust: has([4], ["trust_deed", "spv_documents"]),
    insurance: has([3], ["insurance_policy"]),
  };
}

export function offeringStatus(state: string): CatalogStatus {
  if (state === "live") return "open";
  if (state === "ready") return "soon";
  return "closed";
}

const USE_UR: Record<PropertyUse, string> = { commercial: "کمرشل", residential: "رہائشی", mixed: "مخلوط استعمال" };
const USE_EN: Record<PropertyUse, string> = { commercial: "Commercial", residential: "Residential", mixed: "Mixed-use" };

function offeringName(f: PropertyFacts | null, o: PublicOffering): { en: string; ur: string } {
  const use = (o.use ?? "commercial") as PropertyUse;
  if (f?.building) return { en: f.building, ur: f.building };
  const place = o.district ?? "Pakistan";
  return { en: `${new Map(Object.entries(USE_EN)).get(use) ?? ""} property, ${place}`, ur: `${new Map(Object.entries(USE_UR)).get(use) ?? ""} جائیداد، ${place}` };
}

// ------------------------------------------------------------------ database reads
interface CatalogRow {
  offering_id: string;
  building: string | null;
  covered_area_sqft: string | null;
  built: boolean | null;
  occupancy: Occupancy | null;
  lease_count: number | null;
  monthly_rent_paisa: string | null;
  structure_kind: "reit" | "spv" | null;
  shariah: boolean | null;
  planned_units: string | null;
  max_holding_units: string | null;
  trustee_accepted_at: Date | null;
  sponsor_kyb_approved: boolean | null;
  valuations: number;
  valuation_low_paisa: string | null;
  valuation_high_paisa: string | null;
  valued_on: Date | string | null;
}

async function propertyFacts(): Promise<Map<string, PropertyFacts>> {
  const out = new Map<string, PropertyFacts>();
  try {
    const { rows } = await (await db()).query<CatalogRow>("SELECT * FROM property.web_catalog()");
    for (const r of rows) {
      out.set(r.offering_id, {
        building: r.building,
        coveredAreaSqft: r.covered_area_sqft,
        built: r.built,
        occupancy: r.occupancy,
        leaseCount: r.lease_count,
        monthlyRentPaisa: r.monthly_rent_paisa === null ? null : BigInt(r.monthly_rent_paisa),
        structureKind: r.structure_kind,
        shariah: r.shariah,
        plannedUnits: r.planned_units,
        maxHoldingUnits: r.max_holding_units,
        trusteeAcceptedAt: r.trustee_accepted_at ? r.trustee_accepted_at.toISOString() : null,
        sponsorKybApproved: r.sponsor_kyb_approved === true,
        valuations: r.valuations,
        valuationLowPaisa: r.valuation_low_paisa === null ? null : BigInt(r.valuation_low_paisa),
        valuationHighPaisa: r.valuation_high_paisa === null ? null : BigInt(r.valuation_high_paisa),
        valuedOn: r.valued_on === null ? null : typeof r.valued_on === "string" ? r.valued_on : r.valued_on.toISOString().slice(0, 10),
      });
    }
  } catch {
    // Database without migration 0022 or unavailable: no facts (pages say "not published").
  }
  return out;
}

export async function publishedDocuments(offeringId: string): Promise<PublishedDocument[]> {
  try {
    const { rows } = await (await db()).query<{ doc_type: string; chain_doc_type: string; sha256: string; uploaded_at: Date; verified: boolean }>(
      "SELECT * FROM property.web_documents($1)",
      [offeringId],
    );
    return rows.map((r) => ({ docType: r.doc_type, chainDocType: r.chain_doc_type, sha256: r.sha256, uploadedAt: r.uploaded_at.toISOString(), verified: r.verified }));
  } catch {
    return [];
  }
}

const RECON_TTL_MS = 15_000;
let reconCache: { at: number; value: Promise<ReconSummary | null> } | null = null;

/** Latest finished reconciliation (WA-5), or null when none is visible. */
export function reconSummary(fresh = false): Promise<ReconSummary | null> {
  if (!fresh && reconCache && Date.now() - reconCache.at < RECON_TTL_MS) return reconCache.value;
  const value = (async (): Promise<ReconSummary | null> => {
    try {
      const { rows } = await (await db()).query<{ status: "passed" | "failed"; finished_at: Date; pinned_block: string | null; blocking: number; warnings: number; payouts_allowed: boolean | null }>(
        "SELECT * FROM recon.web_status()",
      );
      const r = rows[0];
      return r
        ? { status: r.status, finishedAt: r.finished_at.toISOString(), pinnedBlock: r.pinned_block, blocking: r.blocking, warnings: r.warnings, payoutsAllowed: r.payouts_allowed }
        : null;
    } catch {
      return null;
    }
  })();
  reconCache = { at: Date.now(), value };
  return value;
}

/** Largest holder's share of the token's supply in basis points (read model), or null. */
export async function topHolderBp(token: string): Promise<number | null> {
  try {
    const { rows } = await (await db()).query<{ top: string | null; total: string | null }>(
      "SELECT max(balance)::text AS top, sum(balance)::text AS total FROM chain.holdings WHERE token = $1 AND balance > 0",
      [token.toLowerCase()],
    );
    const top = BigInt(rows[0]?.top ?? "0");
    const total = BigInt(rows[0]?.total ?? "0");
    return total > 0n ? Number((top * 10_000n) / total) : null;
  } catch {
    return null;
  }
}

async function lastTradePaisa(symbol: string): Promise<bigint | null> {
  try {
    const { rows } = await (await db()).query<{ price_paisa: string }>(
      "SELECT price_paisa FROM webdemo.trades WHERE symbol = $1 AND status = 'settled' ORDER BY created_at DESC LIMIT 1",
      [symbol],
    );
    return rows[0] ? BigInt(rows[0].price_paisa) : null;
  } catch {
    return null;
  }
}

export interface PricePoint {
  /** PKT calendar day, YYYY-MM-DD. */
  day: string;
  closePaisa: bigint;
  volume: bigint;
  trades: number;
}

/** Daily closing price of settled market trades (PKT days), oldest first, at most 365 days. */
export async function priceHistory(symbol: string): Promise<PricePoint[] | null> {
  try {
    const { rows } = await (await db()).query<{ day: string; close: string; volume: string; n: string }>(
      `SELECT to_char((created_at AT TIME ZONE 'Asia/Karachi')::date, 'YYYY-MM-DD') AS day,
              (array_agg(price_paisa ORDER BY created_at DESC, id DESC))[1]::text AS close,
              sum(tokens)::text AS volume, count(*)::text AS n
       FROM webdemo.trades WHERE symbol = $1 AND status = 'settled' AND created_at > now() - interval '365 days'
       GROUP BY 1 ORDER BY 1`,
      [symbol],
    );
    return rows.map((r) => ({ day: r.day, closePaisa: BigInt(r.close), volume: BigInt(r.volume), trades: Number(r.n) }));
  } catch {
    return null;
  }
}

/** Rent distributed per PKT month (not rejected), oldest first, last 24 months. */
export function rentByMonth(dists: Pick<DistributionRow, "status" | "publishedAt" | "totalPaisa">[]): { month: string; paisa: bigint }[] {
  const m = new Map<string, bigint>();
  for (const d of dists) {
    if (d.status === "rejected") continue;
    const pkt = new Date(d.publishedAt.getTime() + PKT_MS);
    const key = `${String(pkt.getUTCFullYear())}-${String(pkt.getUTCMonth() + 1).padStart(2, "0")}-01`;
    m.set(key, (m.get(key) ?? 0n) + d.totalPaisa);
  }
  return [...m.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(-24)
    .map(([month, paisa]) => ({ month, paisa }));
}

// ------------------------------------------------------------------ build
async function tokenEntry(p: Property, recon: ReconSummary | null, now: Date): Promise<CatalogEntry> {
  const token = await liveToken(p.symbol);
  const [dists, docs, figures, top, last] = await Promise.all([
    token ? distributionsOfToken(48) : Promise.resolve(null),
    token ? documentsOfToken() : Promise.resolve(null),
    token ? registerFigures() : Promise.resolve(null),
    token ? topHolderBp(token.address) : Promise.resolve(null),
    lastTradePaisa(p.symbol),
  ]);
  const price = BigInt(p.navPkr) * 100n;
  const y = token && dists ? trailingYield(dists, token.supply, price, now) : null;
  const currentDocs = (docs ?? []).filter((d) => d.supersededBy === null);
  const score = computeScore({
    occupancy: null,
    leaseMonthsRemaining: null,
    rentMonthsLast12: y ? y.months : null,
    documentClasses: docs ? documentClasses(currentDocs.map((d) => d.docType), []) : null,
    reconciliation: recon?.status ?? null,
    topHolderBp: top,
  });
  return {
    key: p.symbol,
    href: `/properties/${p.symbol}`,
    symbol: p.symbol,
    name: p.name,
    city: p.city,
    province: p.province,
    district: p.district,
    use: p.use,
    status: token ? "live" : "unavailable",
    issuePricePaisa: price,
    listed: p,
    token,
    offering: null,
    facts: null,
    documents: [],
    chainDocuments: docs,
    distributions: dists,
    yield: y,
    holders: figures?.holders ?? null,
    topHolderBp: top,
    lastPricePaisa: last,
    score,
    art: p.art,
  };
}

async function offeringEntry(o: PublicOffering, f: PropertyFacts | null, recon: ReconSummary | null): Promise<CatalogEntry> {
  const documents = await publishedDocuments(o.offeringId);
  const score = computeScore({
    occupancy: f?.occupancy ?? null,
    leaseMonthsRemaining: null,
    rentMonthsLast12: null,
    documentClasses: documentClasses([], documents.map((d) => d.docType)),
    reconciliation: recon?.status ?? null,
    topHolderBp: null,
  });
  const use = (o.use ?? null) as PropertyUse | null;
  return {
    key: o.offeringId,
    href: `/properties/${o.offeringId}`,
    symbol: null,
    name: offeringName(f, o),
    city: o.district ? { en: o.district, ur: o.district } : null,
    province: o.province,
    district: o.district,
    use,
    status: offeringStatus(o.state),
    issuePricePaisa: o.pricePaisa,
    listed: null,
    token: null,
    offering: o,
    facts: f,
    documents,
    chainDocuments: null,
    distributions: null,
    yield: null,
    holders: null,
    topHolderBp: null,
    lastPricePaisa: null,
    score,
    art: use === "residential" ? "office" : "mall",
  };
}

async function build(): Promise<Catalog> {
  const now = new Date();
  const [recon, offerings, facts, status] = await Promise.all([reconSummary(), listOfferings().catch(() => [] as PublicOffering[]), propertyFacts(), indexStatus()]);
  const tokens = await Promise.all(PROPERTIES.map((p) => tokenEntry(p, recon, now)));
  const listedTokens = new Set(tokens.map((e) => e.token?.address.toLowerCase()).filter(Boolean));
  const fromOfferings = await Promise.all(
    offerings.filter((o) => !(o.token && listedTokens.has(o.token.toLowerCase()))).map((o) => offeringEntry(o, facts.get(o.offeringId) ?? null, recon)),
  );
  return { at: now.toISOString(), block: status ? status.block.toString() : null, recon, entries: [...tokens, ...fromOfferings] };
}

const TTL_MS = 2_000;
let cache: { at: number; value: Promise<Catalog> } | null = null;

/** The catalogue (shared by every page for 2 s, so page traffic cannot multiply the queries). */
export function catalog(): Promise<Catalog> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const value = build();
  cache = { at: Date.now(), value };
  void value.catch(() => {
    cache = null;
  });
  return value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One catalogue entry by URL key (symbol or offering id); undefined for anything else. */
export async function catalogEntry(key: string): Promise<CatalogEntry | undefined> {
  if (!/^[A-Z][A-Z0-9]{2,11}$/.test(key) && !UUID.test(key)) return undefined;
  return (await catalog()).entries.find((e) => e.key === key);
}
