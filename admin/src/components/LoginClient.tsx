"use client";

import { useEffect, useState } from "react";
import { explain, signIn } from "./webauthn-client";

export function LoginClient({ next }: { next: string | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Disabled until hydrated, so a click can never be lost before the handler exists.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
  }, []);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      window.location.assign(await signIn(next));
    } catch (e) {
      setError(explain(e));
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      {error ? (
        <p className="alert bad" role="alert" data-testid="login-error">
          {error}
        </p>
      ) : null}
      <button className="btn prime big block" type="button" onClick={() => void go()} disabled={busy || !ready}>
        {busy ? "Touch your security key…" : "Sign in with security key"}
      </button>
    </div>
  );
}
