"use client";

import type { RefObject } from "react";
import { StepUpPrompt } from "@/components/passkey/StepUpPrompt";
import { tlabel, type TransferDict } from "@/lib/i18n-transfer";
import type { TransferErrorKey } from "@/lib/transfer-rules";

/** A refused action: the passkey prompt (step-up, then the same form is submitted again) or a friendly message. */
export function FormError({ error, l, form }: { error: TransferErrorKey | undefined; l: TransferDict; form: RefObject<HTMLFormElement | null> }) {
  if (!error) return null;
  if (error === "stepup" || error === "enrolPasskey") return <StepUpPrompt need={error} form={form} />;
  return (
    <div className="alert" role="alert" data-testid="transfer-error">
      {tlabel(l, "err_", error, l.err_generic)}
    </div>
  );
}
