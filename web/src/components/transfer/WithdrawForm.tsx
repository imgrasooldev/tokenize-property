"use client";

import { useActionState, useRef } from "react";
import { withdrawTransferAction, type CaseActionState } from "@/app/actions/transfer";
import type { TransferDict } from "@/lib/i18n-transfer";
import { FormError } from "./FormError";

/** Withdraw (seller) or decline (buyer) before a payment is booked; behind a passkey step-up when the investor has a passkey. */
export function WithdrawForm({ l, caseId, decline }: { l: TransferDict; caseId: string; decline: boolean }) {
  const [state, action, pending] = useActionState<CaseActionState, FormData>(withdrawTransferAction, {});
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form ref={formRef} action={action} className="xfer-actions">
      <input type="hidden" name="caseId" value={caseId} />
      <button type="submit" className="btn secondary small" disabled={pending || state.ok === true}>
        {pending ? l.withdrawBusy : decline ? l.withdrawDecline : l.withdrawBtn}
      </button>
      {state.ok && (
        <span className="up small" role="status">
          {l.withdrawOk}
        </span>
      )}
      <FormError error={state.error} l={l} form={formRef} />
    </form>
  );
}
