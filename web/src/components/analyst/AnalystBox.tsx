"use client";

import Link from "next/link";
import { useActionState, useId, useRef, type KeyboardEvent } from "react";
import { askAction, type AskState } from "@/app/actions/analyst";
import type { Lang } from "@/lib/i18n";
import { analystDict, analystSuggestions } from "@/lib/i18n-analyst";
import type { Scope } from "@/lib/server/analyst/types";
import { AnswerView } from "./AnswerView";

export interface AnalystBoxProps {
  lang: Lang;
  scope: Scope;
  /** Token symbol or offering id (property scope). */
  propertyKey?: string;
  /** Suggested questions; defaults to the scope's suggestions. */
  suggestions?: string[];
  /** Smaller layout without the title and intro. */
  compact?: boolean;
}

/**
 * Property analyst question box (ADR 0015). Answers come from records only, with citations; never
 * investment advice. The server action does all the work; this component only sends the question.
 */
export function AnalystBox({ lang, scope, propertyKey, suggestions, compact = false }: AnalystBoxProps) {
  const [state, action, pending] = useActionState<AskState, FormData>(askAction, {});
  const d = analystDict(lang);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chips = suggestions ?? analystSuggestions(lang, scope);
  const followUps = state.answer?.suggestions ?? [];
  const placeholder = scope === "portfolio" ? d.placeholderPortfolio : scope === "property" ? d.placeholderProperty : d.placeholderSite;

  const ask = (q: string) => {
    if (pending || !inputRef.current) return;
    inputRef.current.value = q;
    formRef.current?.requestSubmit();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      formRef.current?.requestSubmit();
    }
  };
  const errorText = state.error === "input" ? d.errInput : state.error === "signin" ? d.errSignin : state.error === "failed" ? d.errGeneric : null;

  return (
    <section className={`an-box${compact ? " compact" : ""}`} aria-labelledby={`${uid}-title`}>
      <h3 id={`${uid}-title`} className={compact ? "sr-only" : "an-title"}>
        {d.boxTitle}
      </h3>
      {!compact && <p className="an-intro">{d.boxIntro}</p>}
      <form ref={formRef} action={action} className="an-form">
        <input type="hidden" name="scope" value={scope} />
        <input type="hidden" name="lang" value={lang} />
        {propertyKey && <input type="hidden" name="propertyKey" value={propertyKey} />}
        <label htmlFor={`${uid}-q`} className="sr-only">
          {d.questionLabel}
        </label>
        <textarea
          key={state.question ?? ""}
          ref={inputRef}
          id={`${uid}-q`}
          name="question"
          rows={compact ? 1 : 2}
          minLength={2}
          maxLength={300}
          required
          placeholder={placeholder}
          defaultValue={state.question ?? ""}
          onKeyDown={onKey}
          aria-describedby={errorText ? `${uid}-err` : undefined}
        />
        <button type="submit" className="btn small" disabled={pending}>
          {pending ? d.asking : d.askBtn}
        </button>
      </form>
      {chips.length > 0 && (
        <div className="an-chips" role="group" aria-label={d.suggestionsLabel}>
          {chips.map((s) => (
            <button key={s} type="button" className="an-chip" onClick={() => {
                ask(s);
              }} disabled={pending}>
              {s}
            </button>
          ))}
        </div>
      )}
      <div className="an-live" aria-live="polite" aria-busy={pending}>
        {pending && <p className="an-status">{d.asking}</p>}
        {!pending && errorText && (
          <p className="alert small" id={`${uid}-err`}>
            {errorText}
            {state.error === "signin" && (
              <>
                {" "}
                <Link href="/login">{d.signinLink}</Link>
              </>
            )}
          </p>
        )}
        {!pending && state.answer && <AnswerView answer={state.answer} idPrefix={uid} question={state.question} />}
        {!pending && followUps.length > 0 && (
          <div className="an-chips" role="group" aria-label={d.suggestionsLabel}>
            {followUps.map((s) => (
              <button key={s} type="button" className="an-chip" onClick={() => {
                ask(s);
              }}>
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
