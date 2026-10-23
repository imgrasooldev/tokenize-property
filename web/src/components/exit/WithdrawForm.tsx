"use client";

import { useActionState, useRef } from "react";
import { withdrawRedemptionAction, type WithdrawState } from "@/app/actions/exit";
import { StepUpPrompt } from "@/components/passkey/StepUpPrompt";
import { exitLabel, type ExitDict } from "@/lib/i18n-exit";

/** Withdraws a submitted redemption request while its window is open (S-05 EX-44; passkey step-up, always). */
export function WithdrawForm({ l, requestId }: { l: ExitDict; requestId: string }) {
  const [state, action, pending] = useActionState<WithdrawState, FormData>(withdrawRedemptionAction, {});
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form ref={formRef} action={action} className="btn-row start">
      <input type="hidden" name="requestId" value={requestId} />
      <button type="submit" className="btn secondary small" disabled={pending || state.ok === true}>
        {pending ? l.withdrawing : l.withdrawBtn}
      </button>
      {state.ok && (
        <span className="up small" role="status">
          {l.withdrawOk}
        </span>
      )}
      {state.error === "stepup" || state.error === "enrolPasskey" ? (
        <StepUpPrompt need={state.error} form={formRef} />
      ) : (
        state.error && (
          <span className="alert small" role="alert">
            {exitLabel(l, "werr_", state.error, l.werr_generic)}
          </span>
        )
      )}
    </form>
  );
}
