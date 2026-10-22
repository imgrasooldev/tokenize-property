"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { revokePasskey } from "@/app/actions/passkey";
import { fill } from "@/lib/i18n-verify";
import { passkeyError, type PasskeyDict } from "@/lib/i18n-passkey";
import { passkeyNameSchema, type PasskeyError } from "@/lib/passkey-rules";
import { errorKey, registerPasskey, stepUpWithPasskey, supported } from "./passkey-client";
import type { Availability } from "./PasskeySignIn";

export interface PasskeyRow {
  ref: string;
  name: string;
  synced: boolean;
  /** Formatted on the server (no clock or locale differences during hydration). */
  added: string;
  lastUsed: string | null;
  thisSession: boolean;
}

/**
 * The investor's passkeys on /account (T-030): add one (re-authentication enforced by the
 * database), list them (label, kind, added, last used; never credential data) and remove one
 * (after a passkey confirmation within 5 minutes).
 */
export function PasskeyPanel({ l, availability, passkeys }: { l: PasskeyDict; availability: Availability; passkeys: PasskeyRow[] }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [browserOk, setBrowserOk] = useState(true);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<PasskeyError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    setBrowserOk(supported());
    setReady(true);
  }, []);
  const usable = availability.enabled && browserOk;

  async function add() {
    setError(null);
    setDone(null);
    if (!passkeyNameSchema.safeParse(name).success) {
      setError("name");
      return;
    }
    setBusy("add");
    try {
      await registerPasskey(name.trim());
      setName("");
      setDone(l.addedOk);
      router.refresh();
    } catch (e) {
      setError(errorKey(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(ref: string) {
    setError(null);
    setDone(null);
    setBusy(ref);
    try {
      let r = await revokePasskey(ref);
      if ("error" in r && r.error === "stepup") {
        await stepUpWithPasskey();
        r = await revokePasskey(ref);
      }
      if ("error" in r) throw Object.assign(new Error(r.error), { key: r.error });
      setConfirming(null);
      setDone(l.removed);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error && "key" in e ? (e.key as PasskeyError) : errorKey(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel" data-testid="passkey-panel">
      <h2>{l.title}</h2>
      <p className="mu small">{l.intro}</p>
      {!availability.enabled && (
        <p className="note" data-testid="passkey-unavailable">
          {availability.reason === "host" && availability.origin ? fill(l.wrongHost, { o: availability.origin }) : l.unavailable}
        </p>
      )}
      {availability.enabled && ready && !browserOk && <p className="note">{l.unsupported}</p>}
      {error && (
        <div className="alert" role="alert" data-testid="passkey-error">
          {passkeyError(l, error)}
        </div>
      )}
      {done && (
        <p className="up small" role="status" data-testid="passkey-done">
          {done}
        </p>
      )}
      {passkeys.length === 0 ? (
        <p className="small">{l.none}</p>
      ) : (
        <ul className="passkey-list" data-testid="passkey-list" style={{ listStyle: "none", padding: 0, margin: "12px 0", display: "grid", gap: 10 }}>
          {passkeys.map((p) => (
            <li key={p.ref} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div>
                <b>{p.name}</b>{" "}
                <span className="chip">{p.synced ? l.synced : l.deviceBound}</span>
                {p.thisSession && <span className="chip green">{l.thisSession}</span>}
                <div className="fine">
                  {fill(l.added, { d: p.added })} · {p.lastUsed ? fill(l.lastUsed, { d: p.lastUsed }) : l.neverUsed}
                </div>
              </div>
              {confirming === p.ref ? (
                <button type="button" className="btn small" onClick={() => void remove(p.ref)} disabled={!ready || busy !== null}>
                  {busy === p.ref ? l.removing : l.confirmRemove}
                </button>
              ) : (
                <button type="button" className="btn secondary small" onClick={() => {
                    setConfirming(p.ref);
                  }} disabled={!ready || busy !== null}>
                  {l.remove}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {usable && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <label>
            {l.nameLabel}
            <input name="passkeyName" value={name} maxLength={40} placeholder={l.namePlaceholder} onChange={(e) => {
                setName(e.target.value);
              }} autoComplete="off" />
          </label>
          <button type="submit" className="btn" disabled={!ready || busy !== null}>
            {busy === "add" ? l.adding : l.add}
          </button>
        </form>
      )}
      <p className="fine">{l.sessionNote}</p>
      <p className="fine">{l.stepUpNote}</p>
    </section>
  );
}
