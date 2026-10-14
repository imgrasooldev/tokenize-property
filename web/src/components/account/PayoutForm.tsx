"use client";

import { useActionState } from "react";
import { registerPayeeAction, type PayeeState } from "@/app/actions/account";
import type { CatalogDict } from "@/lib/i18n-catalog";

/** Register or change the payout bank account (IBAN + title); the bank service decides. */
export function PayoutForm({ l, hasAccount }: { l: CatalogDict; hasAccount: boolean }) {
  const [state, action, pending] = useActionState<PayeeState, FormData>(registerPayeeAction, {});
  const errors: Record<NonNullable<PayeeState["error"]>, string> = {
    input: l.err_input,
    rate: l.err_rate,
    noKyc: l.noKycRecord,
    invalid_iban: l.err_invalid_iban,
    title_not_found: l.err_title_not_found,
    title_mismatch: l.err_title_mismatch,
    not_verified: l.err_not_verified,
    in_use: l.err_in_use,
    unavailable: l.err_unavailable,
  };
  return (
    <form action={action} className="form" noValidate>
      {state.error && (
        <div className="alert" role="alert">
          {errors[state.error]}
        </div>
      )}
      {state.ok && (
        <div className="alert ok" role="status">
          {l.accSaved}
        </div>
      )}
      <label>
        {l.ibanLabel}
        <input name="iban" dir="ltr" autoComplete="off" spellCheck={false} maxLength={40} required aria-describedby="iban-hint" placeholder="PK36SCBL0000001123456702" />
        <span className="hint" id="iban-hint">
          {l.ibanHint}
        </span>
      </label>
      <label>
        {l.titleLabel}
        <input name="title" autoComplete="name" maxLength={140} required />
      </label>
      <button type="submit" className="btn" disabled={pending}>
        {pending ? l.saving : hasAccount ? l.changeAccount : l.addAccount}
      </button>
      <p className="hint">{l.demoTitleNote}</p>
    </form>
  );
}
