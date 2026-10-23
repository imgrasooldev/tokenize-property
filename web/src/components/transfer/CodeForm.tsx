"use client";

import { useActionState } from "react";
import { receiveCodeAction, type CodeState } from "@/app/actions/transfer";
import type { Lang } from "@/lib/i18n";
import { fill } from "@/lib/i18n-verify";
import { tlabel, type TransferDict } from "@/lib/i18n-transfer";
import { formatPkt } from "@/lib/offering-rules";
import { CopyButton } from "./CopyButton";

/** Makes a receive code (no step-up: it only lets the investor receive) and shows it with a copy button. */
export function CodeForm({ l, lang, disabled }: { l: TransferDict; lang: Lang; disabled: boolean }) {
  const [state, action, pending] = useActionState<CodeState, FormData>(receiveCodeAction, {});
  return (
    <form action={action} className="form">
      {state.error && (
        <div className="alert" role="alert">
          {tlabel(l, "err_", state.error, l.err_generic)}
        </div>
      )}
      {state.code && (
        <div className="raast" role="status" data-testid="new-code">
          <div className="raast-head">{l.codeNew}</div>
          <div className="row-between">
            <span className="mono big-code" dir="ltr">
              {state.code.code}
            </span>
            <CopyButton value={state.code.code} label={l.copy} done={l.copied} />
          </div>
          <span className="small mu">{fill(l.expires, { t: formatPkt(state.code.expiresAt, lang) })}</span>
        </div>
      )}
      <button type="submit" className="btn secondary" disabled={pending || disabled}>
        {pending ? l.codeBusy : l.codeBtn}
      </button>
    </form>
  );
}
