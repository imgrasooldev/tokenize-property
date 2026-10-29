"use client";

import { useActionState, useRef } from "react";
import { withdrawSubscriptionAction, type CancelState } from "@/app/actions/offering";
import { StepUpPrompt } from "@/components/passkey/StepUpPrompt";
import { label, type OfferingDict } from "@/lib/i18n-offering";

/**
 * Withdraw a paid subscription while the withdrawal window is open (S-02 OF-22/OF-23). The backend
 * checks ownership, state and the window and opens the refund; a passkey step-up comes first when
 * the investor has a passkey.
 */
export function WithdrawForm({ l, subscriptionId, until }: { l: OfferingDict; subscriptionId: string; until: string }) {
  const [state, action, pending] = useActionState<CancelState, FormData>(withdrawSubscriptionAction, {});
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form ref={formRef} action={action} className="btn-row" data-testid="withdraw">
      <input type="hidden" name="subscriptionId" value={subscriptionId} />
      <span className="small">{until}</span>
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
            {label(l, "cerr_", state.error, l.cerr_generic)}
          </span>
        )
      )}
    </form>
  );
}
