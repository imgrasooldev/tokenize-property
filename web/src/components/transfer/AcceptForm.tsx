"use client";

import { useActionState, useRef, useState } from "react";
import { acceptTransferAction, type CaseActionState } from "@/app/actions/transfer";
import type { TransferDict } from "@/lib/i18n-transfer";
import { AgreementFile } from "./AgreementFile";
import { FormError } from "./FormError";

/**
 * The buyer accepts by selecting the SAME signed agreement file as the seller: its SHA-256 is
 * computed in the browser and compared by the database (transfer.web_accept). The hash is kept in
 * state, so a passkey step-up can submit the same form again.
 */
export function AcceptForm({ l, caseId, expected }: { l: TransferDict; caseId: string; expected: string }) {
  const [state, action, pending] = useActionState<CaseActionState, FormData>(acceptTransferAction, {});
  const formRef = useRef<HTMLFormElement>(null);
  const [hash, setHash] = useState("");
  const mismatch = hash !== "" && expected !== "" && hash !== expected;
  return (
    <form ref={formRef} action={action} className="form xfer-accept" aria-label={l.acceptTitle} noValidate>
      <h3 className="xfer-sub">{l.acceptTitle}</h3>
      <FormError error={state.error} l={l} form={formRef} />
      {state.ok && (
        <p className="alert ok" role="status">
          {l.acceptOk}
        </p>
      )}
      <input type="hidden" name="caseId" value={caseId} />
      <input type="hidden" name="agreementSha256" value={hash} />
      <AgreementFile l={l} id={`agreement-${caseId}`} hash={hash} onHash={setHash} expected={expected} />
      <button type="submit" className="btn" disabled={pending || hash === "" || mismatch || state.ok === true}>
        {pending ? l.acceptBusy : l.acceptBtn}
      </button>
    </form>
  );
}
