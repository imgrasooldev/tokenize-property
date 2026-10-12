"use client";

import { useEffect, useRef, useState } from "react";
import type { Lang } from "@/lib/i18n";
import { isHealthy, shortHash, type PulseBlock } from "@/lib/pulse-view";
import { usePulse } from "./PulseProvider";

const nf = (lang: Lang) => new Intl.NumberFormat(lang === "ur" ? "ur-PK" : "en-PK");
const price = (n: number, lang: Lang) =>
  new Intl.NumberFormat(lang === "ur" ? "ur-PK" : "en-PK", { style: "currency", currency: "PKR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

export interface RailLabels {
  healthy: string;
  stale: string;
  validators: string;
  block: string;
  blockTime: string;
  ledger: string;
  intact: string;
  broken: string;
  anchor: string;
  comingSoon: string;
  vsNav: string;
}

/** Top status rail: every value is read live from the chain or the ledger. */
export function ChainRail({ lang, l }: { lang: Lang; l: RailLabels }) {
  const p = usePulse();
  if (!p) return null;
  const head = p.blocks.at(0);
  const healthy = isHealthy(p);
  const m = p.market;
  const ref = m ? (m.last ?? m.nav) : null;
  const diff = m && ref !== null ? ((ref - m.nav) / m.nav) * 100 : null;
  return (
    <div className="rail" aria-label={l.healthy}>
      <div className="wrap">
        <span className="row">
          <span className={`dot ${healthy ? "" : "bad"}`} aria-hidden="true" />
          {healthy ? l.healthy : l.stale}
        </span>
        {p.validators !== null && (
          <span className="row" title={`${String(p.validators)} ${l.validators}`}>
            <span className="nodes" aria-hidden="true">
              {Array.from({ length: Math.min(p.validators, 8) }, (_, i) => (
                <i key={i} />
              ))}
            </span>
            <span className="sr-only">
              {p.validators} {l.validators}
            </span>
          </span>
        )}
        <span>
          {l.block} <b className="mono" dir="ltr">{head ? `#${nf(lang).format(head.number)}` : "—"}</b>
        </span>
        {p.blockSeconds !== null && (
          <span>
            {l.blockTime} <b dir="ltr">{p.blockSeconds.toFixed(1)} s</b>
          </span>
        )}
        {m && (
          <span>
            {m.symbol} <b dir="ltr">{ref === null ? "—" : price(ref, lang)}</b>{" "}
            {diff !== null && (
              <span className={diff >= 0 ? "up" : "dn"} dir="ltr">
                {diff >= 0 ? "+" : ""}
                {diff.toFixed(2)}% {l.vsNav}
              </span>
            )}
          </span>
        )}
        {p.ledgerOk !== null && (
          <span>
            {l.ledger} <b className={p.ledgerOk ? "up" : "dn"}>{p.ledgerOk ? l.intact : l.broken}</b>
          </span>
        )}
        <span>
          {l.anchor} <b className="mu">{l.comingSoon}</b>
        </span>
      </div>
    </div>
  );
}

/** Latest block height, updating live. */
export function BlockHeight({ lang, prefix = "#" }: { lang: Lang; prefix?: string }) {
  const p = usePulse();
  const head = p?.blocks.at(0);
  return (
    <span className="mono" dir="ltr">
      {head ? `${prefix}${nf(lang).format(head.number)}` : "—"}
    </span>
  );
}

/** Seconds since the latest block, ticking locally between polls. */
export function BlockAge({ suffix }: { suffix: string }) {
  const p = usePulse();
  // Server time of the pulse until mounted (same value on server and client: no hydration mismatch).
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => {
      if (document.visibilityState === "visible") setNow(Date.now());
    }, 1_000);
    return () => {
      clearInterval(t);
    };
  }, []);
  const head = p?.blocks.at(0);
  if (!head) return null;
  const age = Math.max(0, Math.round((now ?? p?.at ?? 0) / 1000 - head.time));
  return (
    <span dir="ltr">
      {age} s {suffix}
    </span>
  );
}

function useNewBlocks(blocks: PulseBlock[]): Set<number> {
  // Blocks that arrived after the first render get a short highlight.
  const seen = useRef<Set<number> | null>(null);
  seen.current ??= new Set(blocks.map((b) => b.number));
  const fresh = new Set<number>();
  for (const b of blocks) if (!seen.current.has(b.number)) fresh.add(b.number);
  useEffect(() => {
    for (const b of blocks) seen.current?.add(b.number);
  }, [blocks]);
  return fresh;
}

/** Row of the latest real blocks (number, hash, transactions). */
export function BlockRow({ lang, labels }: { lang: Lang; labels: { block: string; tx: string; empty: string } }) {
  const p = usePulse();
  const blocks = p?.blocks ?? [];
  const fresh = useNewBlocks(blocks);
  if (blocks.length === 0) return <p className="note">{labels.empty}</p>;
  return (
    <div className="blkrow" aria-live="off">
      {blocks.map((b) => (
        <div key={b.number} className={`blk ${fresh.has(b.number) ? "new" : ""}`}>
          <span className="mono di">{labels.block}</span>
          <b dir="ltr">#{nf(lang).format(b.number)}</b>
          <span className="mono di" dir="ltr">
            {shortHash(b.hash)}
          </span>
          <div className={b.txs > 0 ? "cy" : "di"} style={{ marginBlockStart: 5 }}>
            {b.txs} {labels.tx}
          </div>
        </div>
      ))}
    </div>
  );
}

export interface TickerItem {
  key: string;
  label: string;
  value: string;
  sub?: string;
  tone?: "up" | "dn" | "cy" | "am";
  sample?: boolean;
}

/**
 * Scrolling strip under the hero (pure CSS animation, paused on hover and focus; static under
 * prefers-reduced-motion). Live blocks come from the pulse; the other items are passed in.
 */
export function TickerStrip({ lang, items, labels }: { lang: Lang; items: TickerItem[]; labels: { block: string; tx: string; sample: string; validators: string; aria: string } }) {
  const p = usePulse();
  const all: TickerItem[] = [];
  const blocks = p?.blocks.slice(0, 5) ?? [];
  blocks.forEach((b, i) => {
    all.push({ key: `b${String(b.number)}`, label: labels.block, value: `#${nf(lang).format(b.number)}`, sub: `${shortHash(b.hash)} · ${String(b.txs)} ${labels.tx}`, tone: "cy" });
    const extra = items.at(i);
    if (extra) all.push(extra);
  });
  for (const extra of items.slice(blocks.length)) all.push(extra);
  if (p?.validators !== null && p?.validators !== undefined) {
    all.push({ key: "val", label: labels.validators, value: `${String(p.validators)} / ${String(p.validators)}`, tone: "up" });
  }
  const row = (hidden: boolean) => (
    <div className="strip-row" aria-hidden={hidden || undefined}>
      {all.map((it) => (
        <div className="strip-item" key={`${hidden ? "h" : "v"}${it.key}`}>
          <span className="mono di">{it.label}</span>
          <b className={it.tone ?? ""} dir="ltr">
            {it.value}
          </b>
          {it.sub && (
            <span className="mono di" dir="ltr">
              {it.sub}
            </span>
          )}
          {it.sample && <span className="chip sample">{labels.sample}</span>}
          <span className="strip-link" aria-hidden="true" />
        </div>
      ))}
    </div>
  );
  return (
    <div className="strip" tabIndex={0} role="region" aria-label={labels.aria}>
      <div className="strip-track">
        {row(false)}
        {row(true)}
      </div>
    </div>
  );
}
