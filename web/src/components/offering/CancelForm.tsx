"use client";

import { useActionState } from "react";
import { cancelReservationAction, type CancelState } from "@/app/actions/offering";
import { label, type OfferingDict } from "@/lib/i18n-offering";

/** Cancel a reservation or leave the queue before paying (S-02 V11). The backend checks ownership and state. */
export function CancelForm({ l, subscriptionId, queued }: { l: OfferingDict; subscriptionId: string; queued: boolean }) {
  const [state, action, pending] = useActionState<CancelState, FormData>(cancelReservationAction, {});
  return (
    <form action={action} className="btn-row">
      <input type="hidden" name="subscriptionId" value={subscriptionId} />
      <button type="submit" className="btn secondary small" disabled={pending || state.ok === true}>
        {pending ? l.cancelling : queued ? l.leaveQueue : l.cancelBtn}
      </button>
      {state.ok && (
        <span className="up small" role="status">
          {l.cancelOk}
        </span>
      )}
      {state.error && (
        <span className="alert small" role="alert">
          {label(l, "cerr_", state.error, l.cerr_generic)}
        </span>
      )}
    </form>
  );
}
