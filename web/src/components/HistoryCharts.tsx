"use client";

import { AreaSeries, createChart, HistogramSeries, type IChartApi } from "lightweight-charts";
import { useEffect, useRef } from "react";

export interface HistoryPoint {
  month: string;
  nav: number;
  rent: number;
}

function theme() {
  // The site has one dark theme (v2 design tokens in globals.css).
  return {
    text: "#8B97AD",
    grid: "rgba(255,255,255,0.05)",
    line: "#22E3F0",
    fill: "rgba(34,227,240,0.22)",
    bar: "rgba(139,92,246,0.75)",
  };
}

function useChart(build: (chart: IChartApi, c: ReturnType<typeof theme>) => void, data: HistoryPoint[]) {
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
  }, [data]);
  return ref;
}

export function NavChart({ data }: { data: HistoryPoint[] }) {
  const ref = useChart((chart, c) => {
    const s = chart.addSeries(AreaSeries, { lineColor: c.line, topColor: c.fill, bottomColor: "transparent", lineWidth: 2 });
    s.setData(data.map((d) => ({ time: d.month, value: d.nav })));
  }, data);
  return <div ref={ref} className="chart" />;
}

export function RentChart({ data }: { data: HistoryPoint[] }) {
  const ref = useChart((chart, c) => {
    const s = chart.addSeries(HistogramSeries, { color: c.bar });
    s.setData(data.map((d) => ({ time: d.month, value: d.rent })));
  }, data);
  return <div ref={ref} className="chart" />;
}
