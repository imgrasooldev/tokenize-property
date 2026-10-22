"use client";

import { AreaSeries, createChart, HistogramSeries, LineSeries, LineStyle, type IChartApi } from "lightweight-charts";
import { useEffect, useRef } from "react";

/**
 * Price and rent history charts from records (T-045). Values arrive as rupees (display only; the
 * server computes them from integer paisa). `time` is a PKT calendar day (YYYY-MM-DD).
 */
export interface ChartPoint {
  time: string;
  value: number;
}

function theme() {
  // The site has one dark theme (v2 design tokens in globals.css).
  return {
    text: "#8B97AD",
    grid: "rgba(255,255,255,0.05)",
    line: "#22E3F0",
    fill: "rgba(34,227,240,0.22)",
    bar: "rgba(139,92,246,0.75)",
    issue: "#F5C46B",
  };
}

function useChart(build: (chart: IChartApi, c: ReturnType<typeof theme>) => void, deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const c = theme();
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: c.text, attributionLogo: true },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false },
      handleScroll: false,
      handleScale: false,
    });
    build(chart, c);
    chart.timeScale().fitContent();
    return () => {
      chart.remove();
    };
    // Rebuild only when the data changes; `build` is recreated on every render by design.
  }, deps);
  return ref;
}

/** Daily closing price of settled trades, with the issue price as a dashed line. */
export function PriceChart({ data, issuePrice, label }: { data: ChartPoint[]; issuePrice: number | null; label: string }) {
  const ref = useChart(
    (chart, c) => {
      const s = chart.addSeries(AreaSeries, { lineColor: c.line, topColor: c.fill, bottomColor: "transparent", lineWidth: 2 });
      s.setData(data);
      if (issuePrice !== null && data.length > 0) {
        const line = chart.addSeries(LineSeries, { color: c.issue, lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false });
        line.setData(data.map((d) => ({ time: d.time, value: issuePrice })));
      }
    },
    [data, issuePrice],
  );
  return <div ref={ref} className="chart" role="img" aria-label={label} />;
}

/** Rent distributed per month (all holders together). */
export function RentChart({ data, label }: { data: ChartPoint[]; label: string }) {
  const ref = useChart(
    (chart, c) => {
      const s = chart.addSeries(HistogramSeries, { color: c.bar });
      s.setData(data);
    },
    [data],
  );
  return <div ref={ref} className="chart" role="img" aria-label={label} />;
}
