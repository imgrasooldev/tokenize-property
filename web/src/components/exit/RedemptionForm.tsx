"use client";

import { useActionState, useRef, useState } from "react";
import { requestRedemptionAction, type RedemptionState } from "@/app/actions/exit";
import { StepUpPrompt } from "@/components/passkey/StepUpPrompt";
import type { Lang } from "@/lib/i18n";
import { exitLabel, type ExitDict } from "@/lib/i18n-exit";
import { fill } from "@/lib/i18n-verify";
import { formatPaisa } from "@/lib/offering-rules";

/**
 * A non-binding redemption request in one open window (S-05 EX-40, phase 0). The indicative value
 * is units x the window's frozen price; nothing is paid and no units move. The database asks for a
 * passkey step-up; the prompt re-submits the same form (same request id, so it cannot count twice).
 */
export function RedemptionForm({
  l,
  lang,
  windowId,
  requestId,
  pricePerUnitPaisa,
  freeUnits,
  freeUnitsText,
}: {
  l: ExitDict;
  lang: Lang;
  windowId: string;
  requestId: string;
  pricePerUnitPaisa: string;
  freeUnits: string;
  freeUnitsText: string;
}) {
  const [state, action, pending] = useActionState<RedemptionState, FormData>(requestRedemptionAction, {});
  const formRef = useRef<HTMLFormElement>(null);
  // Controlled, so the value survives React's form reset after the action (the step-up re-submits it).
  const [units, setUnits] = useState("");
  const n = /^[1-9][0-9]{0,17}$/.test(units) ? BigInt(units) : 0n;
  const id = `units-${windowId}`;

  return (
    <form ref={formRef} action={action} className="form exit-form" noValidate>
      {state.error === "stepup" || state.error === "enrolPasskey" ? (
        <StepUpPrompt need={state.error} form={formRef} />
      ) : (
        state.error && (
          <div className="alert" role="alert">
            {exitLabel(l, "err_", state.error, l.err_generic)}
          </div>
        )
      )}
      <input type="hidden" name="windowId" value={windowId} />
      <input type="hidden" name="requestId" value={requestId} />
      <label htmlFor={id}>
        {l.unitsToRequest}
        <input
          id={id}
          name="units"
          inputMode="numeric"
          dir="ltr"
          required
          maxLength={18}
          value={units}
          onChange={(e) => {
            setUnits(e.target.value.trim());
          }}
          aria-describedby={`${id}-hint`}
        />
        <span className="hint" id={`${id}-hint`}>
          {fill(l.unitsHint, { n: freeUnitsText })}
        </span>
      </label>
      <dl className="kv">
        <dt>{l.indicativeValue}</dt>
        <dd>
          <strong data-testid="indicative-value">{n > 0n ? formatPaisa(n * BigInt(pricePerUnitPaisa), lang) : "—"}</strong>
        </dd>
      </dl>
      <button type="submit" className="btn" disabled={pending || n === 0n || n > BigInt(freeUnits)}>
        {pending ? l.requesting : l.requestBtn}
      </button>
      <p className="hint">{l.requestNote}</p>
    </form>
  );
}
