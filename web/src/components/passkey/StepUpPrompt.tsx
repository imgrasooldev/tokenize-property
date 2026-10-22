"use client";

import Link from "next/link";
import { useEffect, useState, type RefObject } from "react";
import { passkeyDict, passkeyError, type PasskeyDict } from "@/lib/i18n-passkey";
import type { PasskeyError } from "@/lib/passkey-rules";
import { errorKey, stepUpWithPasskey } from "./passkey-client";

/**
 * Shown when the database refused a sensitive action for want of a fresh passkey (T-030, IP-6):
 * "Confirm with passkey" records a step-up on this session, then submits the same form again (the
 * same request id, so a repeat cannot reserve twice). Without a passkey: a link to add one.
 */
export function StepUpPrompt({ need, form }: { need: "stepup" | "enrolPasskey"; form: RefObject<HTMLFormElement | null> }) {
  // Rendered only after the action answered (never during server rendering), so the page's own
  // <html lang> is there to read; this keeps the offering pages' props unchanged.
  const l: PasskeyDict = passkeyDict(typeof document !== "undefined" && document.documentElement.lang === "ur" ? "ur" : "en");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PasskeyError | null>(null);
  useEffect(() => {
    setReady(true);
  }, []);

  if (need === "enrolPasskey") {
    return (
      <div className="alert" role="alert" data-testid="stepup-enrol">
        {l.enrolNeeded}{" "}
        <Link href="/account" className="linklike">
          {l.goAccount}
        </Link>
      </div>
    );
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await stepUpWithPasskey();
      form.current?.requestSubmit();
    } catch (e) {
      setError(errorKey(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="alert" role="alert" data-testid="stepup-needed">
      <p>{l.stepUpNeeded}</p>
      <button type="button" className="btn small" onClick={() => void confirm()} disabled={!ready || busy}>
        {busy ? l.stepUpBusy : l.stepUpBtn}
      </button>
      {error && <p className="small">{passkeyError(l, error)}</p>}
    </div>
  );
}
