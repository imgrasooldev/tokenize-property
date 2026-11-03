import type { Metadata } from "next";
import { ComplianceTabs } from "@/components/ComplianceTabs";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { StepUpForm } from "@/components/StepUp";
import { pkt } from "@/lib/format";
import { rupees } from "@/lib/server/approvals";
import { stateChip } from "@/lib/server/compliance";
import { paramLabel, tmDesk, type TmAlertRow } from "@/lib/server/monitoring";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Transaction monitoring" };

function Alerts({ rows, testId }: { rows: TmAlertRow[]; testId: string }) {
  return (
    <div className="tbl-wrap">
      <table className="t" data-testid={testId}>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Rule</th>
            <th scope="col">Investor</th>
            <th scope="col">What</th>
            <th scope="col" className="n">
              Amount
            </th>
            <th scope="col">State</th>
            <th scope="col">Opened</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              <td className="mono">
                <a href={`/compliance/monitoring/${String(a.id)}`}>#{a.id}</a>
              </td>
              <td className="small">{a.ruleLabel}</td>
              <td className="mono small">{a.subject}</td>
              <td className="small">{a.summary}</td>
              <td className="n small">{a.amountPaisa === "0" ? "–" : rupees(a.amountPaisa)}</td>
              <td>
                <span className={stateChip(a.status)}>{a.status.replace("_", " ")}</span> {a.overdue ? <span className="chip bad">overdue</span> : null}
                {a.strCase ? (
                  <>
                    {" "}
                    <a className="small" href={`/compliance/str/${String(a.strCase)}`}>
                      STR #{a.strCase}
                    </a>
                  </>
                ) : null}
              </td>
              <td className="small nowrap">{pkt(a.openedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Transaction monitoring (migration 0051): the rules that open alerts on an investor's money
 * movements, the review queue and recent decisions. An alert is a candidate: a compliance officer
 * opens an STR case from it or two officers dismiss it. Confidential (tipping-off).
 */
export default async function MonitoringPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("compliance.read", "/compliance/monitoring");
  const q = await searchParams;
  const d = await tmDesk(officer.sessionHash);
  const canDecide = officer.permissions.has("compliance.decide");
  const placeholders = d.rules.filter((r) => r.placeholder).length;

  return (
    <Shell officer={officer} current="/compliance/monitoring" title="Transaction monitoring">
      <ComplianceTabs current="/compliance/monitoring" />
      <Flash q={q} />
      <p className="alert bad" role="note">
        Confidential (tipping-off): an alert is never discussed with the investor or with operations staff, and it does not change the investor&apos;s status.
      </p>

      <section className="card" aria-labelledby="queue" style={{ marginBlockEnd: 12 }}>
        <h2 id="queue">
          Review queue <span className="sp" />
          <span className="mu small" style={{ fontWeight: 400 }}>
            open an STR case, or dismiss with a second officer
          </span>
        </h2>
        {d.open.length === 0 ? <p className="empty">No alert waiting.</p> : <Alerts rows={d.open} testId="tm-open" />}
        {canDecide ? (
          <form method="post" action="/api/compliance/monitoring/sweep" className="row" style={{ marginBlockStart: 8 }}>
            <input type="hidden" name="csrf" value={officer.csrf} />
            <span className="small mu">The rules run with every payment, refund, exit request and new payout account. After a threshold change:</span>
            <button className="btn" type="submit">
              Check every investor now
            </button>
          </form>
        ) : null}
      </section>

      <section className="card" aria-labelledby="rules" style={{ marginBlockEnd: 12 }} data-testid="tm-rules">
        <h2 id="rules">
          Rules <span className="sp" />
          <span className={placeholders ? "chip warn" : "chip ok"}>{placeholders ? `${String(placeholders)} with placeholder thresholds (MLRO to confirm)` : "confirmed"}</span>
        </h2>
        <div className="g2">
          {d.rules.map((r) => (
            <div key={r.code} className="card" data-testid={`tm-rule-${r.code}`}>
              <h3>
                {r.label} <span className="sp" />
                <span className={r.enabled ? "chip ok" : "chip bad"}>{r.enabled ? "on" : "off"}</span> {r.placeholder ? <span className="chip warn">placeholder</span> : null}
              </h3>
              <p className="small mu">
                Opens an STR case as <span className="mono">{r.strCategory}</span> when escalated · changed by <span className="mono">{r.updatedBy}</span> · {pkt(r.updatedAt)}
              </p>
              {canDecide ? (
                <StepUpForm csrf={officer.csrf} action="/api/compliance/monitoring/rules">
                  <input type="hidden" name="rule" value={r.code} />
                  <div className="stack" style={{ gap: 6 }}>
                    {Object.entries(r.spec).map(([k, [min, max]]) => (
                      <label key={k} className="small">
                        {paramLabel(k)}{" "}
                        <input name={`p.${k}`} type="number" required min={min} max={max} step={1} defaultValue={new Map(Object.entries(r.params)).get(k)} />
                      </label>
                    ))}
                    <label className="small">
                      <input type="checkbox" name="enabled" value="yes" defaultChecked={r.enabled} /> Rule on
                    </label>
                    <input name="reason" required minLength={10} maxLength={500} placeholder="Reason (10+ characters)" aria-label={`Reason for ${r.label}`} />
                    <button className="btn" type="submit">
                      Save with security key
                    </button>
                  </div>
                </StepUpForm>
              ) : (
                <ul className="small">
                  {Object.entries(r.params).map(([k, v]) => (
                    <li key={k}>
                      {paramLabel(k)}: <span className="mono">{v}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="card" aria-labelledby="closed">
        <h2 id="closed">Decided alerts</h2>
        {d.closed.length === 0 ? <p className="empty">None yet.</p> : <Alerts rows={d.closed} testId="tm-closed" />}
      </section>
    </Shell>
  );
}
