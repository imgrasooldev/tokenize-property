"use client";

import { useEffect, useRef, useState } from "react";
import type { Lang } from "@/lib/i18n";

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The hero's network canvas (decorative). Cheap by design: one small canvas, at most 36 nodes,
 * device pixel ratio capped at 1.5, about 30 frames a second, and it stops completely while the
 * tab is hidden or the canvas is off screen. Under prefers-reduced-motion it draws one still frame.
 */
export function NetCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const x = c?.getContext("2d");
    if (!c || !x) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const still = reducedMotion();
    let W = 0;
    let H = 0;
    let pts: { x: number; y: number; vx: number; vy: number; r: number }[] = [];
    let pulses: { a: number; b: number; t: number }[] = [];
    let raf = 0;
    let last = 0;
    let onScreen = true;
    const size = () => {
      const r = c.getBoundingClientRect();
      W = c.width = Math.max(1, Math.round(r.width * dpr));
      H = c.height = Math.max(1, Math.round(r.height * dpr));
      const n = r.width < 500 ? 22 : 36;
      pts = Array.from({ length: n }, () => ({
        x: Math.random() * W,
        y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.5 * dpr,
        vy: (Math.random() - 0.5) * 0.5 * dpr,
        r: (Math.random() * 1.8 + 1) * dpr,
      }));
    };
    const draw = () => {
      x.clearRect(0, 0, W, H);
      const d = 150 * dpr;
      for (const p of pts) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > W) p.vx *= -1;
        if (p.y < 0 || p.y > H) p.vy *= -1;
      }
      x.lineWidth = dpr;
      for (let i = 0; i < pts.length; i++) {
        const a = pts.at(i);
        if (!a) continue;
        for (let j = i + 1; j < pts.length; j++) {
          const b = pts.at(j);
          if (!b) continue;
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          if (dist < d) {
            x.strokeStyle = `rgba(34,227,240,${((1 - dist / d) * 0.28).toFixed(3)})`;
            x.beginPath();
            x.moveTo(a.x, a.y);
            x.lineTo(b.x, b.y);
            x.stroke();
          }
        }
      }
      x.fillStyle = "rgba(139,92,246,.9)";
      for (const p of pts) {
        x.beginPath();
        x.arc(p.x, p.y, p.r, 0, 7);
        x.fill();
      }
      if (Math.random() < 0.06) pulses.push({ a: Math.floor(Math.random() * pts.length), b: Math.floor(Math.random() * pts.length), t: 0 });
      pulses = pulses.filter((q) => q.t <= 1);
      x.fillStyle = "rgba(46,242,181,.95)";
      for (const q of pulses) {
        q.t += 0.03;
        const a = pts.at(q.a);
        const b = pts.at(q.b);
        if (!a || !b) continue;
        x.beginPath();
        x.arc(a.x + (b.x - a.x) * q.t, a.y + (b.y - a.y) * q.t, 2.6 * dpr, 0, 7);
        x.fill();
      }
    };
    const loop = (t: number) => {
      raf = 0;
      if (!onScreen || document.visibilityState !== "visible") return;
      if (t - last > 32) {
        last = t;
        draw();
      }
      raf = requestAnimationFrame(loop);
    };
    const start = () => {
      if (!still && raf === 0 && onScreen && document.visibilityState === "visible") raf = requestAnimationFrame(loop);
    };
    size();
    draw();
    const ro = new ResizeObserver(() => {
      size();
      draw();
    });
    ro.observe(c);
    const io = new IntersectionObserver((entries) => {
      onScreen = entries.some((e) => e.isIntersecting);
      start();
    });
    io.observe(c);
    document.addEventListener("visibilitychange", start);
    start();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", start);
    };
  }, []);
  return <canvas ref={ref} className="net" aria-hidden="true" />;
}

/** Counts up to a real figure once it scrolls into view (instant under reduced motion). */
export function CountUp({ value, lang, kind }: { value: number; lang: Lang; kind: "num" | "pkr" }) {
  const fmt = (v: number) => {
    const locale = lang === "ur" ? "ur-PK" : "en-PK";
    return kind === "pkr"
      ? new Intl.NumberFormat(locale, { style: "currency", currency: "PKR", notation: v >= 10_000_000 ? "compact" : "standard", maximumFractionDigits: v >= 10_000_000 ? 1 : 0 }).format(v)
      : new Intl.NumberFormat(locale).format(v);
  };
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState<number>(value);
  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion() || value === 0) return;
    let raf = 0;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      let s: number | null = null;
      const step = (t: number) => {
        s ??= t;
        const k = Math.min(1, (t - s) / 1400);
        setShown(Math.round(value * (1 - Math.pow(1 - k, 3))));
        if (k < 1) raf = requestAnimationFrame(step);
      };
      setShown(0);
      raf = requestAnimationFrame(step);
    });
    io.observe(el);
    return () => {
      io.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [value]);
  return (
    <span ref={ref} dir="ltr">
      {fmt(shown)}
    </span>
  );
}

export interface CalcLabels {
  invest: string;
  amount: string;
  monthly: string;
  yearly: string;
  tokens: string;
  fiveYear: string;
  note: string;
}

/**
 * Returns illustration on the live property's real price (NAV per token) and its catalogue rent
 * yield. Plain arithmetic, nothing promised: the note says rent and prices can go down.
 */
export function ReturnsCalc({ lang, nav, yieldPct, min, l }: { lang: Lang; nav: number; yieldPct: number; min: number; l: CalcLabels }) {
  const [v, setV] = useState(Math.max(min, 250_000));
  const locale = lang === "ur" ? "ur-PK" : "en-PK";
  const pkr = (n: number) => new Intl.NumberFormat(locale, { style: "currency", currency: "PKR", maximumFractionDigits: 0 }).format(n);
  const tokens = Math.floor(v / nav);
  const yearly = (tokens * nav * yieldPct) / 100;
  return (
    <div className="calc">
      <p className="mu" style={{ fontSize: 13, marginBlockStart: 10 }}>
        {l.invest}
      </p>
      <div className="amt" dir="ltr">
        {pkr(v)}
      </div>
      <input
        type="range"
        min={min}
        max={2_000_000}
        step={min}
        value={v}
        aria-label={l.amount}
        aria-valuetext={pkr(v)}
        onChange={(e) => {
          setV(Number(e.target.value));
        }}
      />
      <div className="res">
        <div>
          <small>{l.monthly}</small>
          <b className="grad" dir="ltr">
            {pkr(yearly / 12)}
          </b>
        </div>
        <div>
          <small>{l.yearly}</small>
          <b dir="ltr">{pkr(yearly)}</b>
        </div>
        <div>
          <small>{l.tokens}</small>
          <b dir="ltr">{new Intl.NumberFormat(locale).format(tokens)}</b>
        </div>
        <div>
          <small>{l.fiveYear}</small>
          <b dir="ltr">{pkr(yearly * 5)}</b>
        </div>
      </div>
      <p className="fine">{l.note}</p>
    </div>
  );
}
