"use client";

import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { useEffect, useState } from "react";
import { enrol, enrolOptions, explain } from "./webauthn-client";

/**
 * Enrolment from a one-time link: the token is in the URL fragment (#token=...), which browsers
 * never send to the server or put in a Referer; it is removed from the address bar at once.
 */
export function EnrolClient() {
  const [token, setToken] = useState<string | null>(null);
  const [who, setWho] = useState<{ handle: string; name: string } | null>(null);
  const [options, setOptions] = useState<PublicKeyCredentialCreationOptionsJSON | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "busy" | "done" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const m = /(?:^#|&)token=([A-Za-z0-9_-]{43})(?:&|$)/.exec(window.location.hash);
    window.history.replaceState(null, "", window.location.pathname);
    if (!m?.[1]) {
      setState("error");
      setError("This page needs the one-time enrolment link you were given.");
      return;
    }
    const t = m[1];
    setToken(t);
    enrolOptions(t)
      .then((r) => {
        setWho(r.officer);
        setOptions(r.options);
        setState("ready");
      })
      .catch((e: unknown) => {
        setState("error");
        setError(explain(e));
      });
  }, []);

  async function go() {
    if (!token || !options) return;
    setState("busy");
    setError(null);
    try {
      await enrol(token, options);
      setState("done");
    } catch (e) {
      setError(explain(e));
      // A used challenge cannot be retried: fetch fresh options for another attempt.
      try {
        const r = await enrolOptions(token);
        setOptions(r.options);
        setState("ready");
      } catch (e2) {
        setError(explain(e2));
        setState("error");
      }
    }
  }

  if (state === "done") {
    return (
      <div className="stack">
        <p className="alert ok" role="status" data-testid="enrol-done">
          Security key registered for <b>{who?.name}</b>. Sign in with it now.
        </p>
        <a className="btn prime big block" href="/login">
          Go to sign-in
        </a>
      </div>
    );
  }
  return (
    <div className="stack">
      {who ? (
        <dl className="kv">
          <dt>Officer</dt>
          <dd>{who.name}</dd>
          <dt>Handle</dt>
          <dd className="mono">{who.handle}</dd>
        </dl>
      ) : null}
      {error ? (
        <p className="alert bad" role="alert" data-testid="enrol-error">
          {error}
        </p>
      ) : null}
      <button className="btn prime big block" type="button" onClick={() => void go()} disabled={state !== "ready"}>
        {state === "busy" ? "Touch your security key…" : state === "loading" ? "Checking the link…" : "Register security key"}
      </button>
    </div>
  );
}
