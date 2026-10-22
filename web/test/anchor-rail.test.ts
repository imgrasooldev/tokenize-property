import { describe, expect, it } from "vitest";
import { dictFor } from "../src/lib/i18n";
import { anchorRail, STAND_IN_ANCHOR_CHAIN_ID, type PulseAnchor } from "../src/lib/pulse-view";
import { anchorFresh, anchorIntervalSeconds } from "../src/lib/verify-rules";

/**
 * T-047: the status rail's public-anchoring state (anchor.web_status via the pulse). Green when the
 * latest confirmed anchor is at most 2 x the interval old, amber when older or only pending, red
 * when the newest anchor failed; the local stand-in chain is flagged, never called public.
 */
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const MAX = 2 * 900 * 1000; // demo server: every 15 min
const ok = (o: Partial<Extract<PulseAnchor, { state: "ok" }>> = {}): PulseAnchor => ({
  state: "ok",
  chainId: STAND_IN_ANCHOR_CHAIN_ID,
  besuBlock: "4210",
  confirmedAt: NOW - 5 * 60_000,
  count: 17,
  open: "none",
  maxAgeMs: MAX,
  ...o,
});

describe("anchor state in the status rail", () => {
  it("is fresh up to 2 x the interval and late after it", () => {
    expect(anchorRail(ok(), NOW)).toEqual({ tone: "fresh", ageMs: 5 * 60_000, block: "4210", standIn: true });
    expect(anchorRail(ok({ confirmedAt: NOW - MAX }), NOW).tone).toBe("fresh");
    expect(anchorRail(ok({ confirmedAt: NOW - MAX - 1 }), NOW).tone).toBe("late");
    // A clock a little ahead of the server never shows a negative age.
    expect(anchorRail(ok({ confirmedAt: NOW + 3_000 }), NOW).ageMs).toBe(0);
  });

  it("a pending anchor keeps the latest confirmed age; with none confirmed it is pending (amber)", () => {
    expect(anchorRail(ok({ open: "pending" }), NOW).tone).toBe("fresh");
    expect(anchorRail(ok({ open: "pending", confirmedAt: NOW - MAX - 60_000 }), NOW).tone).toBe("late");
    expect(anchorRail(ok({ open: "pending", confirmedAt: null, besuBlock: null, count: 0 }), NOW)).toEqual({ tone: "pending", ageMs: null, block: null, standIn: true });
  });

  it("is red when the newest anchor failed, even if the last confirmed one is recent", () => {
    expect(anchorRail(ok({ open: "failed" }), NOW).tone).toBe("failed");
    expect(anchorRail(ok({ open: "failed", confirmedAt: null, besuBlock: null, count: 0 }), NOW).tone).toBe("failed");
  });

  it("says none or not available instead of guessing", () => {
    expect(anchorRail(null, NOW).tone).toBe("unavailable");
    expect(anchorRail({ state: "unavailable" }, NOW).tone).toBe("unavailable");
    expect(anchorRail({ state: "none" }, NOW).tone).toBe("none");
  });

  it("flags only the local stand-in chain", () => {
    expect(anchorRail(ok(), NOW).standIn).toBe(true);
    expect(anchorRail(ok({ chainId: 8453 }), NOW).standIn).toBe(false);
  });
});

describe("anchoring interval", () => {
  it("reads ANCHOR_INTERVAL_SECONDS like the anchoring job (10..86,400, default hourly)", () => {
    expect(anchorIntervalSeconds(undefined)).toBe(3_600);
    expect(anchorIntervalSeconds("900")).toBe(900);
    expect(anchorIntervalSeconds("9")).toBe(3_600);
    expect(anchorIntervalSeconds("86401")).toBe(3_600);
    expect(anchorIntervalSeconds("1.5")).toBe(3_600);
    expect(anchorIntervalSeconds("abc")).toBe(3_600);
    expect(anchorIntervalSeconds("")).toBe(3_600);
  });

  it("the page's freshness uses the same 2 x interval bound", () => {
    const now = new Date(NOW);
    expect(anchorFresh(new Date(NOW - MAX), now, MAX).fresh).toBe(true);
    expect(anchorFresh(new Date(NOW - MAX - 1), now, MAX).fresh).toBe(false);
  });
});

describe("rail texts", () => {
  const KEYS = [
    "lastAnchor", "anchorStandInLabel", "anchorStandInTitle", "anchorAnchored", "anchorBlockN", "anchorAgo", "unitMin", "unitHour",
    "anchorLate", "anchorFailed", "anchorPending", "anchorNoneYet", "anchorNotAvailable", "anchorDetails",
  ] as const;

  it("exist in English and Urdu with the same placeholders", () => {
    const en = new Map<string, unknown>(Object.entries(dictFor("en")));
    const ur = new Map<string, unknown>(Object.entries(dictFor("ur")));
    const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const k of KEYS) {
      const e = en.get(k);
      const u = ur.get(k);
      if (typeof e !== "string" || typeof u !== "string") throw new Error(`missing text ${k}`);
      expect(e.length, k).toBeGreaterThan(0);
      expect(u.length, k).toBeGreaterThan(0);
      expect(holes(u), k).toEqual(holes(e));
    }
  });

  it("never call the stand-in a public network", () => {
    for (const lang of ["en", "ur"] as const) {
      const t = dictFor(lang);
      expect(t.anchorStandInLabel).not.toMatch(/public|عوامی|پبلک/i);
    }
    expect(dictFor("en").anchorStandInTitle).toMatch(/not a public network/);
  });
});
