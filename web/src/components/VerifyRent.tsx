"use client";

import { useActionState } from "react";
import { verifyRent, type VerifyState } from "@/app/actions/rent";
import type { Dict } from "@/lib/i18n";

export function VerifyRent({ t, distributionId }: { t: Dict; distributionId: string }) {
  const [state, action, pending] = useActionState<VerifyState, FormData>(verifyRent, {});
  const row = (ok: boolean | undefined, label: string) => (
    <li>
      <span className={`chip ${ok ? "green" : "red"}`}>{ok ? "✓" : "✗"}</span> {label}
    </li>
  );
  return (
    <form action={action} className="verify">
      <input type="hidden" name="distributionId" value={distributionId} />
      <button type="submit" className="btn secondary small" disabled={pending}>
        {pending ? t.verifying : t.verifyMine}
      </button>
      {state.done &&
        (state.error ? (
          <p className="note" role="status">
            {state.error === "chain" ? t.chainUnavailable : state.error === "rate" ? t.errRate : t.noStatement}
          </p>
        ) : (
          <ul className="steps-list" role="status">
            {row(state.statementMatches, t.checkStatement)}
            {row(state.proofValid, t.checkProof)}
            {row(state.tamperedRejected, t.checkTamper)}
          </ul>
        ))}
    </form>
  );
}
