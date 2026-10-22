/**
 * Filters and sorting of the property list (T-045), from URL query parameters. Pure and
 * unit-tested; the page passes every parameter through `parseFilters` (anything unknown is ignored).
 */

export type Tab = "all" | "live" | "soon";
export type SortKey = "score" | "yield" | "price" | "name";

export interface Filters {
  tab: Tab;
  use: "commercial" | "residential" | "mixed" | null;
  /** Lower-case province code or district text (exact, case-insensitive). */
  place: string | null;
  occupancy: "vacant" | "owner_occupied" | "tenanted" | "partly_tenanted" | null;
  /** Minimum trailing yield in basis points (integer), or null. */
  minYieldBp: number | null;
  sort: SortKey;
}

export interface Filterable {
  key: string;
  name: { en: string; ur: string };
  status: "live" | "open" | "soon" | "closed" | "unavailable";
  use: string | null;
  province: string | null;
  district: string | null;
  occupancy: string | null;
  yieldBp: number | null;
  issuePricePaisa: bigint | null;
  score: number | null;
}

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** "8", "8.5", "8.25" (percent, at most two decimals, 0..100) → basis points; anything else → null. */
export function percentToBp(s: string | undefined): number | null {
  if (!s) return null;
  const [whole = "", frac, extra] = s.trim().split(".");
  if (extra !== undefined || !/^[0-9]{1,3}$/.test(whole) || (frac !== undefined && !/^[0-9]{1,2}$/.test(frac))) return null;
  const bp = Number(whole) * 100 + Number((frac ?? "").padEnd(2, "0"));
  return bp <= 10_000 ? bp : null;
}

export function parseFilters(q: Record<string, string | string[] | undefined>): Filters {
  const f = one(q.f);
  const use = one(q.use);
  const place = one(q.place)?.trim().toLowerCase();
  const occ = one(q.occ);
  const sort = one(q.sort);
  return {
    tab: f === "live" || f === "soon" ? f : "all",
    use: use === "commercial" || use === "residential" || use === "mixed" ? use : null,
    place: place && /^[\p{L} .'-]{2,60}$/u.test(place) ? place : null,
    occupancy: occ === "vacant" || occ === "owner_occupied" || occ === "tenanted" || occ === "partly_tenanted" ? occ : null,
    minYieldBp: percentToBp(one(q.minYield)),
    sort: sort === "yield" || sort === "price" || sort === "name" ? sort : "score",
  };
}

export function matches(e: Filterable, f: Filters): boolean {
  if (f.tab === "live" && e.status !== "live" && e.status !== "open") return false;
  if (f.tab === "soon" && e.status !== "soon") return false;
  if (f.use && e.use !== f.use) return false;
  if (f.place && e.province !== f.place && e.district?.toLowerCase() !== f.place) return false;
  if (f.occupancy && e.occupancy !== f.occupancy) return false;
  if (f.minYieldBp !== null && (e.yieldBp === null || e.yieldBp < f.minYieldBp)) return false;
  return true;
}

/** Sorted copy: unknown values (null) always last; ties by name, then key (stable and deterministic). */
export function sortEntries<T extends Filterable>(list: T[], sort: SortKey): T[] {
  const byName = (a: T, b: T): number => a.name.en.localeCompare(b.name.en, "en") || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const desc = (x: number | null, y: number | null): number => (x === y ? 0 : x === null ? 1 : y === null ? -1 : y - x);
  return [...list].sort((a, b) => {
    let c = 0;
    if (sort === "score") c = desc(a.score, b.score);
    else if (sort === "yield") c = desc(a.yieldBp, b.yieldBp);
    else if (sort === "price") {
      const x = a.issuePricePaisa;
      const y = b.issuePricePaisa;
      c = x === y ? 0 : x === null ? 1 : y === null ? -1 : x < y ? -1 : 1;
    }
    return c || byName(a, b);
  });
}

/** The query string for a filter state (empty values dropped), for links and the reset button. */
export function queryOf(f: Partial<Record<"f" | "use" | "place" | "occ" | "minYield" | "sort", string | null>>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}
