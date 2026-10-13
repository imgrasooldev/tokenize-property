import type { ReactNode } from "react";
import type { Gate } from "@/lib/server/approvals";
import { StepUpForm } from "./StepUp";

/** ok / error messages carried back in the query string after a decision (303 redirect). */
export function Flash({ q }: { q: Record<string, string | string[] | undefined> }) {
  const ok = typeof q.ok === "string" ? q.ok.slice(0, 300) : null;
  const error = typeof q.error === "string" ? q.error.slice(0, 300) : null;
  return (
    <>
      {ok ? (
        <p className="alert ok" role="status" data-testid="decision-ok">
          {ok}
        </p>
      ) : null}
      {error ? (
        <p className="alert bad" role="alert" data-testid="decision-error">
          {error}
        </p>
      ) : null}
    </>
  );
}

export function GateChip({ gate }: { gate: Gate | null }) {
  if (!gate) return null;
  return (
    <span className={gate.allowed ? "chip ok" : "chip bad"} title={gate.reason} data-testid="gate-chip">
      {gate.allowed ? "payout gate open" : gate.frozen ? "payouts frozen" : "payout gate closed"}
    </span>
  );
}

/**
 * Approve / reject with a reason and a fresh security-key step-up. The database decides whether the
 * officer may (and the backend whether the action is allowed); this panel only explains in advance
 * why an action is unavailable, so nobody clicks into a refusal they could have seen.
 */
export function DecisionPanel({
  csrf,
  action,
  hidden,
  blockers,
  approveBlockers = [],
  approveLabel = "Approve with security key",
  note,
  extra,
}: {
  csrf: string;
  action: string;
  hidden: Record<string, string>;
  blockers: string[];
  approveBlockers?: string[];
  approveLabel?: string;
  note: string;
  extra?: ReactNode;
}) {
  if (blockers.length > 0) {
    return (
      <div className="stack" data-testid="decision-unavailable">
        <b className="small mu">You cannot decide this now:</b>
        <ul className="checks">
          {blockers.map((b) => (
            <li key={b}>
              <i className="no" aria-hidden="true">
                ✕
              </i>
              <span>{b}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <StepUpForm csrf={csrf} action={action}>
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {extra}
      <label className="small mu" htmlFor="decision-reason">
        Reason (recorded in the audit chains; at least 10 characters)
      </label>
      <textarea id="decision-reason" name="reason" required minLength={10} maxLength={500} placeholder="Reason (at least 10 characters)" />
      {approveBlockers.length > 0 ? (
        <ul className="checks" data-testid="approve-unavailable">
          {approveBlockers.map((b) => (
            <li key={b}>
              <i className="wait" aria-hidden="true">
                !
              </i>
              <span>Approval unavailable: {b}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="row">
        <button className="btn ok" type="submit" name="decision" value="approve" disabled={approveBlockers.length > 0}>
          {approveLabel}
        </button>
        <button className="btn no" type="submit" name="decision" value="reject">
          Reject with security key
        </button>
        <span className="sp" />
        <span className="di small">{note}</span>
      </div>
    </StepUpForm>
  );
}
