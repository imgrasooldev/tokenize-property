import Link from "next/link";
import { PakistanMap } from "@/components/catalog/PakistanMap";
import { PublicPage } from "@/components/Shell";
import { matches, parseFilters, queryOf, sortEntries, type Filterable } from "@/lib/catalog-filter";
import { formatNumber, loc } from "@/lib/i18n";
import { fill } from "@/lib/i18n-verify";
import { catalogDict, clabel } from "@/lib/i18n-catalog";
import { label, offeringDict } from "@/lib/i18n-offering";
import { bpText, formatPaisa } from "@/lib/offering-rules";
import { catalog, PROVINCES, type CatalogEntry } from "@/lib/server/catalog";
import { getDict } from "@/lib/server/lang";

export const dynamic = "force-dynamic";

const TONE: Record<string, string> = { live: "ok", open: "ok", soon: "cy", closed: "gray", unavailable: "warn" };

function filterable(e: CatalogEntry): Filterable & { e: CatalogEntry } {
  return {
    e,
    key: e.key,
    name: e.name,
    status: e.status,
    use: e.use,
    province: e.province,
    district: e.district,
    occupancy: e.facts?.occupancy ?? null,
    yieldBp: e.yield?.yieldBp ?? null,
    issuePricePaisa: e.issuePricePaisa,
    score: e.score.score,
  };
}

/** All properties with records: filters, sort and the map are server-side (URL query, no script needed). */
export default async function PropertiesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { lang, t } = await getDict();
  const l = catalogDict(lang);
  const lo = offeringDict(lang);
  const q = await searchParams;
  const f = parseFilters(q);
  const cat = await catalog();
  const all = cat.entries.map(filterable);
  const shown = sortEntries(
    all.filter((x) => matches(x, f)),
    f.sort,
  );
  const keep = {
    use: f.use,
    place: f.place,
    occ: f.occupancy,
    minYield: f.minYieldBp === null ? null : bpText(f.minYieldBp),
    sort: f.sort === "score" ? null : f.sort,
  };
  const tabs = [
    { key: "all", label: l.tabAll, href: `/properties${queryOf({ ...keep })}` },
    { key: "live", label: l.tabLive, href: `/properties${queryOf({ ...keep, f: "live" })}` },
    { key: "soon", label: l.tabSoon, href: `/properties${queryOf({ ...keep, f: "soon" })}` },
  ];
  const districts = [...new Set(cat.entries.map((e) => e.district).filter((d): d is string => Boolean(d)))].sort();

  return (
    <PublicPage active="properties">
      <main id="main" className="wrap page">
        <div className="kicker">{"// "}{t.kPropsList}</div>
        <h1 className="page-title">
          {l.listTitle1} <span className="grad">{l.listTitle2}</span>
        </h1>

        <PakistanMap entries={cat.entries} lang={lang} l={l} />

        <nav className="tabs" aria-label={l.tabsLabel} style={{ marginBlockStart: 16 }}>
          {tabs.map((x) => (
            <Link key={x.key} href={x.href} className={x.key === f.tab ? "on" : undefined} aria-current={x.key === f.tab ? "page" : undefined}>
              {x.label}
            </Link>
          ))}
        </nav>

        <form className="filters filter-form" method="get" action="/properties" aria-label={t.filterLabel}>
          {f.tab !== "all" && <input type="hidden" name="f" value={f.tab} />}
          <label>
            {l.filterUse}
            <select name="use" defaultValue={f.use ?? ""}>
              <option value="">{l.any}</option>
              {(["commercial", "residential", "mixed"] as const).map((u) => (
                <option key={u} value={u}>
                  {label(lo, "use_", u)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {l.filterPlace}
            <select name="place" defaultValue={f.place ?? ""}>
              <option value="">{l.any}</option>
              {PROVINCES.map((p) => (
                <option key={p} value={p}>
                  {label(lo, "province_", p, p)}
                </option>
              ))}
              {districts.map((d) => (
                <option key={d} value={d.toLowerCase()}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label>
            {l.filterOccupancy}
            <select name="occ" defaultValue={f.occupancy ?? ""}>
              <option value="">{l.any}</option>
              {(["tenanted", "partly_tenanted", "owner_occupied", "vacant"] as const).map((o) => (
                <option key={o} value={o}>
                  {clabel(l, "occ_", o)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {l.filterMinYield}
            <input name="minYield" inputMode="decimal" dir="ltr" maxLength={6} pattern="[0-9]{1,3}(\.[0-9]{1,2})?" defaultValue={keep.minYield ?? ""} />
          </label>
          <label>
            {l.sortBy}
            <select name="sort" defaultValue={f.sort}>
              {(["score", "yield", "price", "name"] as const).map((s) => (
                <option key={s} value={s}>
                  {clabel(l, "sort_", s)}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn small">
            {l.apply}
          </button>
          <Link href="/properties" className="btn secondary small">
            {l.reset}
          </Link>
        </form>

        <p className="mu small" role="status">
          {fill(l.resultsN, { n: formatNumber(shown.length, lang), t: formatNumber(all.length, lang) })}
        </p>

        {shown.length === 0 ? (
          <p className="note">{f.tab === "soon" ? l.soonEmpty : l.noResults}</p>
        ) : (
          <div className="glass table-wrap">
            <table className="table t">
              <thead>
                <tr>
                  <th scope="col">{t.property}</th>
                  <th scope="col">{l.location}</th>
                  <th scope="col" className="n">
                    {l.issuePrice}
                  </th>
                  <th scope="col" className="n">
                    {l.trailingYield}
                  </th>
                  <th scope="col">{l.filterOccupancy}</th>
                  <th scope="col">{t.registerIssued}</th>
                  <th scope="col">{l.scoreTitle}</th>
                  <th scope="col">{t.status}</th>
                  <th scope="col">
                    <span className="sr-only">{t.viewShort}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map(({ e }) => {
                  const issuedBp = e.token && e.token.cap > 0n ? Number((e.token.supply * 10_000n) / e.token.cap) : null;
                  const tone = new Map(Object.entries(TONE)).get(e.status) ?? "gray";
                  return (
                    <tr key={e.key}>
                      <td>
                        <b>{loc(e.name, lang)}</b>
                        <div className="di mono small">
                          {e.symbol ?? label(lo, "st_", e.offering?.state ?? "")} · {e.use ? label(lo, "use_", e.use) : l.notPublished}
                        </div>
                      </td>
                      <td>
                        {e.city ? loc(e.city, lang) : (e.district ?? "—")}
                        {e.province ? <div className="di small">{label(lo, "province_", e.province, e.province)}</div> : null}
                      </td>
                      <td className="n">{e.issuePricePaisa === null ? "—" : formatPaisa(e.issuePricePaisa, lang)}</td>
                      <td className="n up">{e.yield?.yieldBp ? `${bpText(e.yield.yieldBp)}%` : "—"}</td>
                      <td>{e.facts?.occupancy ? clabel(l, "occ_", e.facts.occupancy) : <span className="mu">{l.notPublished}</span>}</td>
                      <td style={{ minInlineSize: 120 }}>
                        <div className="bar">
                          <i style={{ inlineSize: `${issuedBp === null ? "0" : bpText(Math.min(issuedBp, 10_000))}%` }} />
                        </div>
                        <span className="mono di small">{issuedBp === null ? "—" : `${bpText(issuedBp)}%`}</span>
                      </td>
                      <td>{e.score.score === null ? <span className="mu">—</span> : <span className="chip cy">{e.score.score}</span>}</td>
                      <td>
                        <span className={`chip ${tone}`}>
                          {(e.status === "live" || e.status === "open") && <span className="dot" aria-hidden="true" />}
                          {clabel(l, "status_", e.status)}
                        </span>
                      </td>
                      <td>
                        <Link className={`btn small ${e.status === "live" || e.status === "open" ? "" : "secondary"}`} href={e.href}>
                          {t.viewShort}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="fine">{l.listNote}</p>
        <p className="fine">{cat.block ? t.asOfBlock.replace("{b}", cat.block) : t.readModelDown}</p>
      </main>
    </PublicPage>
  );
}
