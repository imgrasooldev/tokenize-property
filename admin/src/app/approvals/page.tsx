import type { Metadata } from "next";
import { Flash, GateChip } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { StepUpForm } from "@/components/StepUp";
import { pkt, short } from "@/lib/format";
import { inbox, kindLabel, rupees, transitionLabel } from "@/lib/server/approvals";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Approvals" };

/**
 * Approvals inbox (Step 6b): signing requests waiting for checkers, payout batches waiting for a
 * decision or submission, reconciliation unfreeze requests and, for property readers, the S-01
 * requests. Every view is audited (page.view). Decisions happen on each item's page.
 */
export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("approvals.read", "/approvals");
  const q = await searchParams;
  const box = await inbox(officer.sessionHash);
  const signer = box.signer ?? [];
  const payouts = box.payouts ?? [];
  const unfreeze = box.unfreeze ?? [];
  const property = box.property ?? [];
  const canRequest = officer.permissions.has("approvals.request");
  const canHold = officer.permissions.has("payouts.hold");

  return (
    <Shell officer={officer} current="/approvals" title="Approvals" actions={<GateChip gate={box.gate} />}>
      <Flash q={q} />
      <div className="kpis" data-testid="inbox-kpis">
        <div className="kpi">
          <div className="label">Signing requests</div>
          <div className="val">{signer.length}</div>
          <div className="sub">waiting for checkers</div>
        </div>
        <div className="kpi">
          <div className="label">Payout batches</div>
          <div className="val">{payouts.length}</div>
          <div className="sub">to decide or submit</div>
        </div>
        <div className="kpi">
          <div className="label">Unfreeze requests</div>
          <div className="val">{unfreeze.length}</div>
          <div className="sub">open</div>
        </div>
        <div className="kpi">
          <div className="label">Property &amp; KYB</div>
          <div className="val">{property.length}</div>
          <div className="sub">open requests</div>
        </div>
        <div className="kpi">
          <div className="label">Payout gate</div>
          <div className={box.gate?.allowed ? "val up" : "val dn"}>{box.gate?.allowed ? "Open" : "Closed"}</div>
          <div className="sub">{box.gate?.reason ?? "–"}</div>
        </div>
        <div className="kpi">
          <div className="label">Rule</div>
          <div className="val small" style={{ fontSize: 13 }}>
            Maker ≠ checker
          </div>
          <div className="sub">step-up &lt; 5 min · reason · audit</div>
        </div>
      </div>

      <section className="card" aria-labelledby="sig">
        <h2 id="sig">
          Signing requests <span className="sp" />
          <span className="mu small" style={{ fontWeight: 400 }}>
            decided by the signing service with your one-time ticket
          </span>
        </h2>
        {signer.length === 0 ? (
          <p className="empty">Nothing is waiting for approval.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="t" data-testid="inbox-signer">
              <thead>
                <tr>
                  <th scope="col">Request</th>
                  <th scope="col">Action</th>
                  <th scope="col">Recipient / account</th>
                  <th scope="col">Requested by</th>
                  <th scope="col" className="n">
                    Approvals
                  </th>
                  <th scope="col">Expires</th>
                </tr>
              </thead>
              <tbody>
                {signer.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">
                      <a href={`/approvals/signer/${r.id}`}>{short(r.id.replace(/-/g, ""), 4)}</a>
                    </td>
                    <td>
                      <b>{kindLabel(r.kind, r.amount)}</b> <span className="mono di small">{r.kind}</span>
                    </td>
                    <td className="mono small">{r.to ? short(r.to, 6) : r.distributionId ? `distribution ${r.distributionId}` : "–"}</td>
                    <td className="mono small">{r.requestedBy}</td>
                    <td className="n">
                      <span className={r.approvals > 0 ? "chip warn" : "chip"}>
                        {r.approvals} / {r.approvalsNeeded}
                      </span>{" "}
                      {r.mine ? <span className="chip cy">you decided</span> : null}
                    </td>
                    <td className={r.expired ? "dn small" : "mono small"}>{r.expired ? "window closed" : pkt(r.expiresAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="g2">
        <section className="card" aria-labelledby="pay">
          <h2 id="pay">
            Payout batches <span className="sp" />
            <GateChip gate={box.gate} />
          </h2>
          {payouts.length === 0 ? (
            <p className="empty">No batch waiting for a decision or submission.</p>
          ) : (
            <div className="tbl-wrap">
              <table className="t" data-testid="inbox-payouts">
                <thead>
                  <tr>
                    <th scope="col">Batch</th>
                    <th scope="col">Distribution</th>
                    <th scope="col" className="n">
                      Paid now
                    </th>
                    <th scope="col" className="n">
                      Lines (held)
                    </th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {payouts.map((b) => (
                    <tr key={b.id}>
                      <td className="mono">
                        <a href={`/approvals/payouts/${String(b.id)}`}>{b.reference}</a>
                        {b.kind === "follow_up" ? <span className="chip">follow-up</span> : null}
                      </td>
                      <td className="mono small">
                        #{b.distributionId} · {short(b.token, 4)}
                      </td>
                      <td className="n">{rupees(b.paidPaisa)}</td>
                      <td className="n">
                        {b.items} ({b.held})
                      </td>
                      <td>
                        <span className={b.status === "approved" ? "chip ok" : "chip warn"}>{b.status === "approved" ? "approved · to submit" : "to decide"}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card" aria-labelledby="unf">
          <h2 id="unf">Unfreeze requests</h2>
          {unfreeze.length === 0 ? <p className="empty">No open request.</p> : null}
          <div className="stack">
            {unfreeze.map((u) => (
              <a key={u.id} className="req" href={`/approvals/unfreeze/${String(u.id)}`} data-testid={`unfreeze-${String(u.id)}`}>
                <span className="row">
                  <b>Unfreeze payouts (freeze #{u.freezeEvent})</b>
                  <span className="sp" />
                  <span className={u.expired ? "chip bad" : "chip warn"}>{u.expired ? "expired" : "open"}</span>
                </span>
                <span className="mu small">{u.reason}</span>
                <span className="mono di small">
                  by {u.requestedBy} · {pkt(u.requestedAt)}
                </span>
              </a>
            ))}
          </div>
          {canRequest && box.gate?.frozen ? (
            <div className="stack" style={{ marginBlockStart: 10 }}>
              <b className="small">Ask for an unfreeze (maker)</b>
              <StepUpForm csrf={officer.csrf} action="/api/approvals/unfreeze">
                <label className="sr-only" htmlFor="unfreeze-reason">
                  Why payouts can resume
                </label>
                <textarea id="unfreeze-reason" name="reason" required minLength={10} maxLength={500} placeholder="Why payouts can resume (at least 10 characters)" />
                <div className="row">
                  <button className="btn" type="submit" name="decision" value="request">
                    Request unfreeze (a checker decides)
                  </button>
                </div>
              </StepUpForm>
            </div>
          ) : null}
          {canHold && !box.gate?.frozen ? (
            <div className="stack" style={{ marginBlockStart: 10 }} data-testid="emergency-hold">
              <b className="small">Emergency payout hold (platform owner)</b>
              <span className="mu small">Stops every payout at once. Operations lift it maker-checker after a new reconciliation run passes.</span>
              <StepUpForm csrf={officer.csrf} action="/api/approvals/hold">
                <label className="sr-only" htmlFor="hold-reason">
                  Why payouts must stop
                </label>
                <textarea id="hold-reason" name="reason" required minLength={10} maxLength={500} placeholder="Why payouts must stop now (at least 10 characters)" />
                <div className="row">
                  <button className="btn no" type="submit" name="decision" value="hold">
                    Hold all payouts now
                  </button>
                </div>
              </StepUpForm>
            </div>
          ) : null}
        </section>
      </div>

      {box.property !== null ? (
        <section className="card" aria-labelledby="prop">
          <h2 id="prop">
            Property &amp; KYB requests <span className="sp" />
            <a className="small" href="/approvals/property">
              all property requests →
            </a>
          </h2>
          {property.length === 0 ? (
            <p className="empty">No open S-01 request.</p>
          ) : (
            <ul className="checks">
              {property.slice(0, 6).map((p) => (
                <li key={p.id}>
                  <i className="wait" aria-hidden="true">
                    {p.code}
                  </i>
                  <a href={`/approvals/property/${String(p.id)}`}>
                    {transitionLabel(p.code)} · {p.entity} {short(p.entityId.replace(/-/g, ""), 4)}
                  </a>
                  <span className="mono di small">by {p.requestedBy}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </Shell>
  );
}
