"use client";

import { useActionState, useRef } from "react";
import { voteAction, type VoteState } from "@/app/actions/votes";
import { StepUpPrompt } from "@/components/passkey/StepUpPrompt";
import type { VotesDict } from "@/lib/i18n-votes";

/**
 * One ballot of a token-holder poll (migration 0046). The database asks for a passkey step-up first
 * when the investor has a passkey; the vote is final.
 */
export function VoteForm({ l, poll, options }: { l: VotesDict; poll: number; options: string[] }) {
  const [state, action, pending] = useActionState<VoteState, FormData>(voteAction, {});
  const formRef = useRef<HTMLFormElement>(null);
  if (state.ok) {
    return (
      <p className="up" role="status">
        {l.ok}
      </p>
    );
  }
  const message =
    state.error === "rate" ? l.err_rate : state.error === "closed" ? l.err_closed : state.error === "generic" ? l.err_generic : null;
  return (
    <form ref={formRef} action={action} className="btn-row">
      <input type="hidden" name="poll" value={String(poll)} />
      {options.map((o, i) => (
        <button key={o} type="submit" name="choice" value={String(i)} className="btn secondary" disabled={pending}>
          {l.vote}: {o}
        </button>
      ))}
      {state.error === "stepup" || state.error === "enrolPasskey" ? (
        <StepUpPrompt need={state.error} form={formRef} />
      ) : (
        message && (
          <span className="alert small" role="alert">
            {message}
          </span>
        )
      )}
    </form>
  );
}
