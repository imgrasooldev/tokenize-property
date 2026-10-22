import Link from "next/link";
import { loc, type Lang } from "@/lib/i18n";
import { clabel, type CatalogDict } from "@/lib/i18n-catalog";
import type { CatalogEntry } from "@/lib/server/catalog";
import { placeOf } from "@/lib/server/catalog";

/**
 * A simplified outline of Pakistan, drawn here as an inline SVG (no map tiles, no external origin,
 * CSP unchanged), with one marker per catalogue property at its district centre. Coordinates are
 * approximate on purpose: no addresses or GPS points are published (migration 0022 WA-3).
 */

// (lon, lat) clockwise from Jiwani on the Arabian Sea; about 0.3 degree accuracy.
const OUTLINE: [number, number][] = [
  [61.6, 25.2], [62.3, 25.1], [63.5, 25.2], [64.6, 25.25], [66.0, 25.4], [66.7, 24.85], [67.2, 24.6], [67.5, 23.9],
  [68.2, 23.7], [68.8, 24.0], [70.0, 24.2], [71.0, 24.4], [70.6, 25.7], [70.1, 26.5], [69.5, 27.0], [70.4, 28.0],
  [71.9, 27.9], [72.9, 28.9], [73.4, 29.9], [74.0, 30.4], [74.6, 31.1], [74.6, 31.9], [75.3, 32.3], [74.7, 32.8],
  [74.3, 33.4], [74.0, 34.0], [74.3, 34.7], [75.3, 34.9], [76.5, 35.3], [77.8, 35.5], [76.8, 36.2], [75.9, 36.7],
  [75.0, 37.0], [74.4, 37.0], [73.0, 36.8], [71.6, 36.5], [71.2, 36.0], [71.6, 35.3], [71.1, 34.4], [70.0, 34.0],
  [69.5, 33.0], [69.3, 31.9], [68.0, 31.6], [66.6, 31.2], [66.3, 29.9], [64.5, 29.5], [62.5, 29.4], [60.9, 29.85],
  [61.6, 29.0], [62.8, 28.2], [62.7, 27.3], [63.2, 26.6], [62.3, 26.4], [61.7, 25.8],
];

const SCALE = 22;
const LON0 = 60.5;
const LAT0 = 37.4;
const px = (lon: number, lat: number): [number, number] => [Math.round((lon - LON0) * SCALE * 10) / 10, Math.round((LAT0 - lat) * SCALE * 10) / 10];
const PATH = `M${OUTLINE.map(([lon, lat]) => px(lon, lat).join(" ")).join(" L")} Z`;

const TONE: Record<string, string> = { live: "#2EF2B5", open: "#22E3F0", soon: "#F5C46B", closed: "#8B97AD", unavailable: "#FF6B81" };

export function PakistanMap({ entries, lang, l }: { entries: CatalogEntry[]; lang: Lang; l: CatalogDict }) {
  const placed = entries
    .map((e) => ({ e, at: placeOf(e.province, e.district) }))
    .filter((x): x is { e: CatalogEntry; at: { lat: number; lon: number } } => x.at !== null);
  return (
    <figure className="map glass pkmap" aria-labelledby="pkmap-title">
      <figcaption id="pkmap-title" className="pkmap-h">
        <b>{l.mapTitle}</b>
        <span className="fine">{l.mapNote}</span>
      </figcaption>
      <svg viewBox="0 0 380 310" width="100%" height="300" role="img" aria-labelledby="pkmap-title" className="pkmap-svg">
        <path d={PATH} fill="rgba(34,227,240,.05)" stroke="rgba(34,227,240,.45)" strokeWidth="1.2" strokeLinejoin="round" />
        {placed.map(({ e, at }, i) => {
          const [x, y] = px(at.lon, at.lat);
          // Several properties in one district fan out a little so each marker stays visible.
          const dx = (i % 3) * 6;
          const color = new Map(Object.entries(TONE)).get(e.status) ?? "#8B97AD";
          return (
            <g key={e.key} className={e.status === "live" || e.status === "open" ? "map-pulse" : undefined}>
              <circle cx={x + dx} cy={y} r="7" fill={color} opacity=".9">
                <title>{`${loc(e.name, lang)} · ${clabel(l, "status_", e.status)}`}</title>
              </circle>
            </g>
          );
        })}
      </svg>
      {placed.length === 0 ? (
        <p className="note">{l.mapEmpty}</p>
      ) : (
        <ul className="map-list">
          {placed.map(({ e }) => (
            <li key={e.key}>
              <span className="dot" style={{ background: new Map(Object.entries(TONE)).get(e.status) ?? "#8B97AD" }} aria-hidden="true" />
              <Link href={e.href}>{loc(e.name, lang)}</Link> · {e.district ?? (e.city ? loc(e.city, lang) : "")} · {clabel(l, "status_", e.status)}
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
