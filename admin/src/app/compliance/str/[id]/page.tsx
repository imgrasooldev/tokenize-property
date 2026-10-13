import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActionPanel, type PanelAction } from "@/components/ActionPanel";
import { ComplianceTabs } from "@/components/ComplianceTabs";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { StepUpForm } from "@/components/StepUp";
import { pkt, short } from "@/lib/format";
import { actionLabel, stateChip, STR_ACTIONS, strCase } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "STR case" };

/**
 * One STR case: summary, investor (masked), append-only notes, history, FMU exports (each recorded
 * with its SHA-256 before release) and the actions with the database's reasons when unavailable.
 */
export default async function StrCasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const valid = /^[1-9]\d{0,17}$/.test(id);
  const officer = await requirePage("compliance.read", `/compliance/str/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const s = await strCase(officer.sessionHash, id);
  if (!s) notFound();
  const actions: PanelAction[] = STR_ACTIONS.map((a) => ({
    action: a,
    label: actionLabel(a),
    blockers: new Map(Object.entries(s.blockers)).get(a) ?? [],
    tone: a === "mark_filed" || a === "confirm_close" ? "ok" : a === "decline_close" ? "no" : "plain",
  }));

  return (
    <Shell officer={officer} current="/compliance/str" title={`STR case #${String(s.id)}`}>
      <ComplianceTabs current="/compliance/str" />
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="case">
          <h2 id="case">
            {s.categoryLabel ?? s.category} <span className="sp" />
            <span className={stateChip(s.status)} data-testid="str-status">
              {s.status.replace("_", " ")}
            </span>
          </h2>
          <p style={{ marginBlockEnd: 8, whiteSpace: "pre-wrap" }}>{s.summary}</p>
          <dl className="kv">
            <dt>Opened</dt>
            <dd>
              <span className="mono">{s.openedBy}</span> · {pkt(s.openedAt)}
            </dd>
            <dt>Closing proposed</dt>
            <dd>{s.closeProposedBy ? `${s.closeProposedBy} · ${s.closeProposedReason ?? ""}` : "–"}</dd>
            <dt>Closed</dt>
            <dd>{s.closedBy ? `${s.closedBy} · ${s.closedReason ?? ""}` : "–"}</dd>
            <dt>Filed with the FMU</dt>
            <dd>{s.filedBy ? `${s.filedBy} · ref ${s.fmuReference ?? ""} · ${pkt(s.finishedAt)}` : "–"}</dd>
            <dt>Investor</dt>
            <dd className="mono small">
              {s.subject ? `${s.subject.ref} · ${s.subject.cnic} · ${s.subject.status}${s.subject.wallet ? ` · ${short(s.subject.wallet, 6)}` : ""}` : "–"}
            </dd>
          </dl>
        </section>
        <section className="card" aria-labelledby="act">
          <h2 id="act">Actions</h2>
          <ActionPanel
            csrf={officer.csrf}
            action={`/api/compliance/str/${String(s.id)}/act`}
            hidden={{ digest: s.digest }}
            actions={actions}
            note="Closing without a report needs a second officer."
            extra={
              <input name="fmuReference" maxLength={40} placeholder="FMU reference (only to record the filing)" aria-label="FMU reference" />
            }
          />
          <h2 style={{ marginBlockStart: 12 }}>Export for the FMU</h2>
          {s.blockers.export.length === 0 ? (
            <StepUpForm csrf={officer.csrf} action={`/api/compliance/str/${String(s.id)}/export`}>
              <p className="small mu">ZIP with the case, notes and history, a manifest and SHA256SUMS; recorded before it is handed out. Nothing is sent automatically.</p>
              <div className="row">
                <button className="btn" type="submit" name="decision" value="export">
                  Export with security key
                </button>
              </div>
            </StepUpForm>
          ) : (
            <p className="small mu">{s.blockers.export.join(" ")}</p>
          )}
          {s.exports.length > 0 ? (
            <ul className="checks" data-testid="exports">
              {s.exports.map((x) => (
                <li key={x.id}>
                  <i className="wait" aria-hidden="true">
                    ⇩
                  </i>
                  <span className="mono small">
                    {x.by} · {pkt(x.at)} · sha256 {short(x.sha256, 8)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>
      <div className="g2">
        <section className="card" aria-labelledby="notes">
          <h2 id="notes">Notes (append-only)</h2>
          {s.notes.length === 0 ? <p className="empty">No note yet.</p> : null}
          <ul className="checks" data-testid="notes">
            {s.notes.map((n) => (
              <li key={n.id}>
                <i className="wait" aria-hidden="true">
                  ✎
                </i>
                <span>
                  <span className="mono small">
                    {n.author} · {pkt(n.at)}
                  </span>
                  <br />
                  <span style={{ whiteSpace: "pre-wrap" }}>{n.body}</span>
                </span>
              </li>
            ))}
          </ul>
          {s.blockers.note.length === 0 ? (
            <form method="post" action={`/api/compliance/str/${String(s.id)}/notes`} className="stack" style={{ marginBlockStart: 10 }}>
              <input type="hidden" name="csrf" value={officer.csrf} />
              <textarea name="body" required minLength={2} maxLength={2000} placeholder="Add a note (never edited or deleted; no CNIC, IBAN or phone number)" aria-label="Note" />
              <button className="btn" type="submit">
                Add note
              </button>
            </form>
          ) : null}
        </section>
        <section className="card" aria-labelledby="hist">
          <h2 id="hist">History</h2>
          <ul className="checks" data-testid="events">
            {s.events.map((e, i) => (
              <li key={`${e.at}-${String(i)}`}>
                <i className="wait" aria-hidden="true">
                  •
                </i>
                <span>
                  <b>{actionLabel(e.action)}</b> {e.from ? `${e.from} → ` : ""}
                  {e.to} · <span className="mono small">{e.actor}</span> · {pkt(e.at)}
                  <br />
                  <span className="mu small">{e.reason}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Shell>
  );
}
