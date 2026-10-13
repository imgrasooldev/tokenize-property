"use client";

import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { explain, stepUp } from "./webauthn-client";

/** "Confirm with security key": records a fresh assertion on the session (step-up, 5 minutes). */
export function StepUpButton({ csrf, freshUntil }: { csrf: string; freshUntil: string | null }) {
  const [until, setUntil] = useState<string | null>(freshUntil);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
  }, []);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      const at = await stepUp(csrf);
      setUntil(at ? new Date(Date.parse(at) + 5 * 60_000).toISOString() : null);
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <div className="row">
        <button className="btn" type="button" onClick={() => void go()} disabled={busy || !ready}>
          {busy ? "Touch your security key…" : "Confirm with security key"}
        </button>
        <span data-testid="stepup-state" className={until ? "chip ok" : "chip"}>
          {until ? `step-up valid until ${until.slice(11, 19)} UTC` : "no recent step-up"}
        </span>
      </div>
      {error ? (
        <p className="alert bad" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A decision form that first performs a step-up, then submits natively (the server and the
 * database refuse the decision without a step-up less than five minutes old).
 */
export function StepUpForm({ csrf, action, children }: { csrf: string; action: string; children: ReactNode }) {
  const ref = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Until hydrated the controls are disabled: a native submit would skip the step-up.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
  }, []);
  async function submit(e: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    e.preventDefault();
    const form = ref.current;
    if (!form) return;
    const submitter = e.nativeEvent.submitter as HTMLButtonElement | null;
    setBusy(true);
    setError(null);
    try {
      await stepUp(csrf);
      // Keep the clicked button's name/value (approve or reject) in the native submission.
      const choice = document.createElement("input");
      choice.type = "hidden";
      choice.name = submitter?.name ?? "decision";
      choice.value = submitter?.value ?? "";
      form.appendChild(choice);
      form.submit();
    } catch (err) {
      setError(explain(err));
      setBusy(false);
    }
  }
  return (
    <form ref={ref} method="post" action={action} onSubmit={(e) => void submit(e)} className="stack">
      <input type="hidden" name="csrf" value={csrf} />
      {/* Disabled only before hydration; never while submitting (disabled controls are not sent). */}
      <fieldset disabled={!ready} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 8 }} aria-busy={busy}>
        {children}
      </fieldset>
      {busy ? <p className="small mu">Touch your security key to confirm…</p> : null}
      {error ? (
        <p className="alert bad" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
