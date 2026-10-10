"use client";

import { useActionState } from "react";
import { signUp, type SignUpState } from "@/app/actions/auth";
import type { Dict } from "@/lib/i18n";

export function SignUpForm({ t }: { t: Dict }) {
  const [state, action, pending] = useActionState<SignUpState, FormData>(signUp, {});
  const errorText =
    state.error === "nadra"
      ? t.errNadra
      : state.error === "duplicate"
        ? t.errDuplicate
        : state.error === "rate"
          ? t.errRate
          : state.error === "chain"
          ? t.errChain
          : state.error
            ? t.errGeneric
            : null;
  const fieldError = (name: keyof NonNullable<SignUpState["fields"]>) => {
    const msg = new Map(Object.entries(state.fields ?? {})).get(name);
    return msg ? (
      <span className="field-error" id={`${name}-error`}>
        {msg}
      </span>
    ) : null;
  };

  return (
    <form action={action} className="panel form" noValidate>
      {errorText && (
        <div className="alert" role="alert">
          {errorText}
        </div>
      )}
      <label>
        {t.fullName}
        <input name="fullName" autoComplete="name" required maxLength={80} aria-describedby="fullName-error" />
        {fieldError("fullName")}
      </label>
      <label>
        {t.cnic}
        <input name="cnic" inputMode="numeric" placeholder="35202-1234567-1" required maxLength={15} dir="ltr" aria-describedby="cnic-hint cnic-error" />
        <span className="hint" id="cnic-hint">
          {t.cnicHint}
        </span>
        {fieldError("cnic")}
      </label>
      <label>
        {t.phone}
        <input name="phone" inputMode="tel" autoComplete="tel" placeholder="0300-1234567" required maxLength={12} dir="ltr" aria-describedby="phone-hint phone-error" />
        <span className="hint" id="phone-hint">
          {t.phoneHint}
        </span>
        {fieldError("phone")}
      </label>
      <label className="check">
        <input type="checkbox" name="liveness" />
        <span>{t.liveness}</span>
      </label>
      {fieldError("liveness")}
      <label className="check">
        <input type="checkbox" name="consent" />
        <span>{t.consent}</span>
      </label>
      {fieldError("consent")}
      <p className="hint">{t.privacyNote}</p>
      <button type="submit" className="btn" disabled={pending}>
        {pending ? t.submitting : t.submit}
      </button>
    </form>
  );
}
