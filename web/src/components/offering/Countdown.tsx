"use client";

import { useEffect, useState } from "react";
import { countdown, countdownText } from "@/lib/offering-rules";

/**
 * Time left on a reservation. Renders the server's time first (no Date.now() during SSR, so no
 * hydration mismatch), then ticks every second in the browser. The expiry itself is enforced by the
 * database; this is a reminder only.
 */
export function Countdown({ expiresAt, serverNow, upText }: { expiresAt: string; serverNow: number; upText: string }) {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, []);
  const c = countdown(expiresAt, now);
  return (
    <span role="timer" className={`mono ${c.done ? "dn" : c.h < 2 ? "am" : "up"}`} dir="ltr">
      {c.done ? upText : countdownText(c)}
    </span>
  );
}
