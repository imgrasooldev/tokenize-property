"use client";

import { useEffect, useState } from "react";
import { fill } from "@/lib/i18n-verify";
import { passkeyError, type PasskeyDict } from "@/lib/i18n-passkey";
import type { PasskeyError } from "@/lib/passkey-rules";
import { errorKey, signInWithPasskey, supported } from "./passkey-client";

export type Availability = { enabled: true } | { enabled: false; reason: "unset" | "insecure" | "host"; origin?: string };

/**
 * "Sign in with passkey" (T-030): discoverable credentials, so nothing is typed. Disabled until
 * hydrated (a click before the handler exists would be lost). Where passkeys cannot work (the
 * plain-HTTP IP demo, a different address) it says why instead; the demo sign-in keeps working.
 */
export function PasskeySignIn({ l, availability }: { l: PasskeyDict; availability: Availability }) {
  const [ready, setReady] = useState(false);
  const [browserOk, setBrowserOk] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PasskeyError | null>(null);
  useEffect(() => {
    setBrowserOk(supported());
    setReady(true);
  }, []);

  if (!availability.enabled) {
    return (
      <div className="stack">
        <button type="button" className="btn secondary block" disabled aria-describedby="passkey-why">
          {l.signIn}
        </button>
        <p className="note" id="passkey-why" data-testid="passkey-unavailable">
          {availability.reason === "host" && availability.origin ? fill(l.wrongHost, { o: availability.origin }) : l.unavailable}
        </p>
      </div>
    );
  }

  async function go() {
    setBusy(true);
    setError(null);
    try {
      window.location.assign(await signInWithPasskey());
    } catch (e) {
      setError(errorKey(e));
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {error && (
        <div className="alert" role="alert" data-testid="passkey-error">
          {passkeyError(l, error)}
        </div>
      )}
      <button type="button" className="btn secondary block" onClick={() => void go()} disabled={!ready || busy || !browserOk}>
        {busy ? l.signingIn : l.signIn}
      </button>
      {ready && !browserOk && <p className="note">{l.unsupported}</p>}
    </div>
  );
}
