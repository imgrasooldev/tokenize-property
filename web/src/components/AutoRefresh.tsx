"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";

/**
 * Re-renders the current page from the server every few seconds while it is rendered (only on
 * pages that show something pending: a subscription, a trade or a sign-up on its way through the
 * outbox). Never stacks refreshes: the next one starts only after the previous render arrived, so a
 * slow server is not flooded. Stops while the tab is hidden. Renders nothing.
 */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);
  useEffect(() => {
    busy.current = pending;
  }, [pending]);
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== "visible" || busy.current) return;
      startTransition(() => {
        router.refresh();
      });
    }, Math.max(1, seconds) * 1000);
    return () => {
      clearInterval(id);
    };
  }, [router, seconds]);
  return null;
}
