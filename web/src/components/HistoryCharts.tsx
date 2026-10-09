"use client";

import { AreaSeries, createChart, HistogramSeries, type IChartApi } from "lightweight-charts";
import { useEffect, useRef } from "react";

export interface HistoryPoint {
  month: string;
  nav: number;
  rent: number;
}

function theme() {
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return {
    text: dark ? "#9aa7b2" : "#5b6770",
    grid: dark ? "#22303b" : "#eef1f4",
    line: dark ? "#2bb3a5" : "#0f766e",
    fill: dark ? "rgba(43,179,165,0.18)" : "rgba(15,118,110,0.14)",
    bar: dark ? "#f0a34a" : "#b45309",
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
