import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActionPanel, type PanelAction } from "@/components/ActionPanel";
import { ComplianceTabs } from "@/components/ComplianceTabs";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { StepUpForm } from "@/components/StepUp";
import { pkt, short } from "@/lib/format";
import { rupees } from "@/lib/server/approvals";
import { stateChip } from "@/lib/server/compliance";
import { paramLabel, TM_ACTIONS, tmActionLabel, tmAlert } from "@/lib/server/monitoring";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Monitoring alert" };

/**
 * One monitoring alert (migration 0051): what the rule found (references and amounts only), the
 * thresholds it used, the investor (masked), the history and the decisions. Opening an STR case
 * takes one compliance officer; dismissing takes two.
 */
export default async function MonitoringAlertPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const valid = /^[1-9]\d{0,17}$/.test(id);
  const officer = await requirePage("compliance.read", `/compliance/monitoring/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const a = await tmAlert(officer.sessionHash, id);
  if (!a) notFound();
  const actions: PanelAction[] = TM_ACTIONS.map((x) => ({
    action: x,
    label: tmActionLabel(x),
    blockers: new Map(Object.entries(a.blockers)).get(x) ?? [],
    tone: x === "escalate" ? "ok" : x === "decline_dismiss" ? "no" : "plain",
  }));

  return (
    <Shell officer={officer} current="/compliance/monitoring" title={`Monitoring alert #${String(a.id)}`}>
      <ComplianceTabs current="/compliance/monitoring" />
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="alert">
          <h2 id="alert">
            {a.ruleLabel} <span className="sp" />
            <span className={stateChip(a.status)} data-testid="tm-status">
              {a.status.replace("_", " ")}
            </span>
          </h2>
          <p style={{ marginBlockEnd: 8 }}>{a.summary}</p>
          <dl className="kv">
            <dt>Window</dt>
            <dd>
              {pkt(a.windowFrom)} – {pkt(a.windowTo)}
            </dd>
            <dt>Amount</dt>
            <dd>{a.amountPaisa === "0" ? "–" : rupees(a.amountPaisa)}</dd>
            <dt>Thresholds used</dt>
            <dd className="small">
              {Object.entries(a.params)
                .map(([k, v]) => `${paramLabel(k)}: ${String(v)}`)
                .join(" · ")}
            </dd>
            <dt>Declared annual income</dt>
            <dd>{a.declaredIncomePaisa ? rupees(a.declaredIncomePaisa) : "not recorded"}</dd>
            <dt>Opened</dt>
            <dd>
              <span className="mono">{a.openedBy}</span> · {pkt(a.openedAt)}
            </dd>
            <dt>Dismissing proposed</dt>
            <dd>{a.dismissProposedBy ? `${a.dismissProposedBy} · ${a.dismissReason ?? ""}` : "–"}</dd>
            <dt>STR case</dt>
            <dd>{a.strCase ? <a href={`/compliance/str/${String(a.strCase)}`}>#{a.strCase}</a> : "–"}</dd>
            <dt>Investor</dt>
            <dd className="mono small">
              {a.investor ? `${a.investor.ref} · ${a.investor.cnic} · ${a.investor.status}${a.investor.wallet ? ` · ${short(a.investor.wallet, 6)}` : ""}` : "–"}
            </dd>
          </dl>
        </section>
        <section className="card" aria-labelledby="act">
          <h2 id="act">Decision</h2>
          <ActionPanel
            csrf={officer.csrf}
            action={`/api/compliance/monitoring/${String(a.id)}/act`}
            hidden={{ digest: a.digest }}
            actions={actions}
            note="Opening an STR case takes one compliance officer; dismissing needs a second officer."
          />
          {officer.permissions.has("compliance.decide") && a.investor ? (
            <>
              <h2 style={{ marginBlockStart: 12 }}>Declared annual income</h2>
              <StepUpForm csrf={officer.csrf} action="/api/compliance/monitoring/income">
                <input type="hidden" name="subject" value={a.investor.id} />
                <input type="hidden" name="back" value={`/compliance/monitoring/${String(a.id)}`} />
                <div className="stack" style={{ gap: 6 }}>
                  <input name="rupees" required inputMode="numeric" maxLength={16} placeholder="Upper end of the band, whole rupees" aria-label="Declared annual income (Rs)" />
                  <input name="reason" required minLength={10} maxLength={500} placeholder="Source (KYC form, salary slip, tax return; 10+ characters)" aria-label="Income reason" />
                  <button className="btn" type="submit">
                    Record with security key
                  </button>
                </div>
              </StepUpForm>
            </>
          ) : null}
        </section>
      </div>
      <div className="g2">
        <section className="card" aria-labelledby="evidence">
          <h2 id="evidence">What the rule found</h2>
          <div className="tbl-wrap">
            <table className="t" data-testid="tm-evidence">
              <thead>
                <tr>
                  <th scope="col">Kind</th>
                  <th scope="col">Reference</th>
                  <th scope="col">When</th>
                  <th scope="col" className="n">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {a.evidence.map((e) => (
                  <tr key={`${e.kind}-${e.ref}`}>
                    <td className="small">{e.kind.replace("_", " ")}</td>
                    <td className="mono small">
                      {e.ref}
                      {e.last4 ? ` · …${e.last4}` : ""}
                    </td>
                    <td className="small nowrap">{e.at ? pkt(e.at) : "–"}</td>
                    <td className="n small">{e.amountPaisa ? rupees(e.amountPaisa) : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="card" aria-labelledby="hist">
          <h2 id="hist">History</h2>
          <ul className="checks" data-testid="tm-events">
            {a.events.map((e, i) => (
              <li key={`${e.at}-${String(i)}`}>
                <i className="wait" aria-hidden="true">
                  •
                </i>
                <span>
                  <b>{tmActionLabel(e.action)}</b> {e.from ? `${e.from} → ` : ""}
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
