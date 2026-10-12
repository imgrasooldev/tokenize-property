"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Pulse } from "@/lib/pulse-view";

const PulseContext = createContext<Pulse | null>(null);

const POLL_MS = 2_000;

/**
 * Shares one live network pulse with every component on the page. Polls the public, server-cached
 * `/api/chain/pulse` (same origin) every 2 s, only while the tab is visible.
 */
export function PulseProvider({ initial, children }: { initial: Pulse; children: ReactNode }) {
  const [pulse, setPulse] = useState(initial);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      timer = undefined;
      if (document.visibilityState === "visible") {
        try {
          const res = await fetch("/api/chain/pulse", { cache: "no-store" });
          if (res.ok) {
            const next = (await res.json()) as Pulse;
            if (!stopped) setPulse(next);
          }
        } catch {
          // keep the last value; the rail shows when it gets stale
        }
      }
      inFlight = false;
      if (!stopped) timer = setTimeout(() => void tick(), POLL_MS);
    };
    timer = setTimeout(() => void tick(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && timer) {
        clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return <PulseContext.Provider value={pulse}>{children}</PulseContext.Provider>;
}

export function usePulse(): Pulse | null {
  return useContext(PulseContext);
}
