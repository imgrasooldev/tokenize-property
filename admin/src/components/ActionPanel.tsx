import type { ReactNode } from "react";
import { StepUpForm } from "./StepUp";

export interface PanelAction {
  action: string;
  label: string;
  /** Why this officer cannot take the action now (from the database); empty = available. */
  blockers: string[];
  tone?: "ok" | "no" | "plain";
}

/**
 * Several possible actions on one item (Step 6c), each with the database's own explanation when it
 * is unavailable. One reason field, a fresh security-key step-up, then a native form post; the
 * hidden fields carry what the officer reviewed (digest), so a changed item is refused.
 */
export function ActionPanel({
  csrf,
  action,
  hidden,
  actions,
  note,
  extra,
  reasonLabel = "Reason (recorded in the audit chains; at least 10 characters, never a CNIC, IBAN or phone number)",
}: {
  csrf: string;
  action: string;
  hidden: Record<string, string>;
  actions: PanelAction[];
  note: string;
  extra?: ReactNode;
  reasonLabel?: string;
}) {
  const available = actions.filter((a) => a.blockers.length === 0);
  const unavailable = actions.filter((a) => a.blockers.length > 0);
  return (
    <div className="stack" data-testid="action-panel">
      {available.length > 0 ? (
        <StepUpForm csrf={csrf} action={action}>
          {Object.entries(hidden).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          {extra}
          <label className="small mu" htmlFor="action-reason">
            {reasonLabel}
          </label>
          <textarea id="action-reason" name="reason" required minLength={10} maxLength={500} placeholder="Reason (at least 10 characters)" />
          <div className="row" style={{ flexWrap: "wrap" }}>
            {available.map((a) => (
              <button key={a.action} className={a.tone === "ok" ? "btn ok" : a.tone === "no" ? "btn no" : "btn"} type="submit" name="decision" value={a.action}>
                {a.label}
              </button>
            ))}
            <span className="sp" />
            <span className="di small">{note}</span>
          </div>
        </StepUpForm>
      ) : (
        <p className="small mu" data-testid="no-actions">
          No action is available to you on this item now.
        </p>
      )}
      {unavailable.length > 0 ? (
        <ul className="checks" data-testid="actions-unavailable">
          {unavailable.map((a) => (
            <li key={a.action}>
              <i className="no" aria-hidden="true">
                ✕
              </i>
              <span>
                <b>{a.label}:</b> {a.blockers.join(" ")}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
