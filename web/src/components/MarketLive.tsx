"use client";

import {
  CandlestickSeries,
  createChart,
  HistogramSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import type { Dict, Lang } from "@/lib/i18n";
import { formatNumber, formatPrice } from "@/lib/i18n";
import type { MarketView } from "@/lib/market-view";

function palette() {
  // The site has one dark theme (v2 design tokens in globals.css).
  return {
    text: "#8B97AD",
    grid: "rgba(255,255,255,0.05)",
    up: "#3BE89B",
    down: "#FF6B81",
    vol: "rgba(139,92,246,0.35)",
    nav: "#FFB547",
  };
}

/** `yieldBp`: rent yield of the last 12 months on the issue price (distributions on chain), or null. */
export function MarketLive({ symbol, nav, yieldBp, initial, t, lang }: { symbol: string; nav: number; yieldBp: number | null; initial: MarketView; t: Dict; lang: Lang }) {
  const [view, setView] = useState(initial);
  const [live, setLive] = useState<"connecting" | "live" | "retrying">("connecting");
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<{ c: ISeriesApi<"Candlestick">; v: ISeriesApi<"Histogram"> } | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const p = palette();
    const ch = createChart(el, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: p.text, attributionLogo: true },
      grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
    });
    const c = ch.addSeries(CandlestickSeries, {
      upColor: p.up,
      downColor: p.down,
      borderVisible: false,
      wickUpColor: p.up,
      wickDownColor: p.down,
    });
    c.createPriceLine({ price: nav, color: p.nav, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "NAV" });
    const v = ch.addSeries(HistogramSeries, { color: p.vol, priceScaleId: "", priceFormat: { type: "volume" } });
    v.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    chart.current = ch;
    series.current = { c, v };
    return () => {
      ch.remove();
      chart.current = null;
      series.current = null;
    };
  }, [nav]);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    s.c.setData(view.candles.map((k) => ({ time: k.time as UTCTimestamp, open: k.open, high: k.high, low: k.low, close: k.close })));
    s.v.setData(view.candles.map((k) => ({ time: k.time as UTCTimestamp, value: k.volume })));
    chart.current?.timeScale().fitContent();
  }, [view]);

  useEffect(() => {
    const es = new EventSource(`/api/market/${encodeURIComponent(symbol)}/stream`);
    es.addEventListener("market", (e) => {
      setLive("live");
      try {
        setView(JSON.parse((e as MessageEvent<string>).data) as MarketView);
      } catch {
        // ignore a malformed frame; the next one replaces it
      }
    });
    es.onopen = () => {
      setLive("live");
    };
    es.onerror = () => {
      setLive("retrying");
    };
    return () => {
      es.close();
    };
  }, [symbol]);

  const vsNav = view.last === null ? null : ((view.last - nav) / nav) * 100;
  const depth = Math.max(1, ...view.bids.map((b) => b.tokens), ...view.asks.map((a) => a.tokens));
  const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-4)}`;

  return (
    <div className="market-live">
      <section className="panel">
        <div className="market-head">
          <div className="stats">
            <div className="stat">
              <div className="label">{t.lastPrice}</div>
              <div className="value">{view.last === null ? "—" : formatPrice(view.last, lang)}</div>
            </div>
            <div className="stat">
              <div className="label">{t.vsNav}</div>
              <div className={`value ${vsNav === null ? "" : vsNav >= 0 ? "up" : "down"}`} dir="ltr">
                {vsNav === null ? "—" : `${vsNav >= 0 ? "+" : ""}${vsNav.toFixed(2)}%`}
              </div>
            </div>
            <div className="stat">
              <div className="label">{t.volume24h}</div>
              <div className="value">{formatNumber(view.volume24h, lang)}</div>
            </div>
          </div>
          <span className={`chip ${live === "live" ? "green" : "amber"}`} role="status">
            ● {live === "live" ? t.liveFeed : t.reconnecting}
          </span>
        </div>
        <div ref={box} className="chart tall" aria-label={t.priceChart} />
        <p className="note">{t.chartNote}</p>
        <div className="ai-box compact">
          <div className="hd">
            <span className="orb small" aria-hidden="true" />
            {t.marketNote}
            <span className="chip ai">{t.fromLiveData}</span>
          </div>
          <span className="ai-text">
            {view.last === null || vsNav === null
              ? t.marketNoteEmpty
              : t.marketNoteText
                  .replace("{d}", `${vsNav >= 0 ? "+" : ""}${vsNav.toFixed(2)}%`)
                  .replace("{n}", String(Math.min(view.trades.length, 15)))
                  .replace("{y}", yieldBp === null ? "" : t.marketYieldText.replace("{y}", ((nav * yieldBp) / 100 / view.last).toFixed(2)))}{" "}
            <span className="cite">trades</span> <span className="cite">NAV</span>
          </span>
        </div>
      </section>

      <div className="market-grid">
        <section className="panel">
          <h2>{t.orderBook}</h2>
          <table className="table book">
            <thead>
              <tr>
                <th>{t.price}</th>
                <th>{t.tokens}</th>
              </tr>
            </thead>
            <tbody>
              {[...view.asks].reverse().map((a) => (
                <tr key={`a${a.price}`} className="ask">
                  <td style={{ backgroundSize: `${(a.tokens / depth) * 100}% 100%` }}>{formatPrice(a.price, lang)}</td>
                  <td>{formatNumber(a.tokens, lang)}</td>
                </tr>
              ))}
              <tr className="spread">
                <td colSpan={2}>{view.asks.length === 0 && view.bids.length === 0 ? t.emptyBook : t.spread}</td>
              </tr>
              {view.bids.map((b) => (
                <tr key={`b${b.price}`} className="bid">
                  <td style={{ backgroundSize: `${(b.tokens / depth) * 100}% 100%` }}>{formatPrice(b.price, lang)}</td>
                  <td>{formatNumber(b.tokens, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="panel">
          <h2>{t.recentTrades}</h2>
          {view.trades.length === 0 ? (
            <p className="note">{t.noTrades}</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t.time}</th>
                    <th>{t.price}</th>
                    <th>{t.tokens}</th>
                    <th>{t.onChain}</th>
                  </tr>
                </thead>
                <tbody>
                  {view.trades.slice(0, 15).map((tr) => (
                    <tr key={tr.id}>
                      <td dir="ltr">{new Date(tr.at).toLocaleTimeString("en-GB", { timeZone: "Asia/Karachi" })}</td>
                      <td>{formatPrice(tr.price, lang)}</td>
                      <td>{formatNumber(tr.tokens, lang)}</td>
                      <td className="mono">{tr.tx ? short(tr.tx) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
