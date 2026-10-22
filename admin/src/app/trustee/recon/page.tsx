import type { Metadata } from "next";
import { GateChip } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { TrusteeTabs } from "@/components/TrusteeTabs";
import { int, pkt } from "@/lib/format";
import { stateChip } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";
import { reconView } from "@/lib/server/trustee";

export const metadata: Metadata = { title: "Reconciliation" };

const DAYS = 14;

/**
 * Daily reconciliation reports for the trustee (read-only): chain ↔ ledger ↔ bank runs grouped by
 * day in Pakistan time, each run pinned to a read-model block, and the payout gate they control.
 */
export default async function TrusteeReconPage() {
  const officer = await requirePage("trustee.read", "/trustee/recon");
  const r = await reconView(officer.sessionHash, DAYS);

  return (
    <Shell officer={officer} current="/trustee/recon" title="Reconciliation" actions={<GateChip gate={r.gate} />}>
      <TrusteeTabs current="/trustee/recon" />
      <div className="g2">
        <section className="card" aria-labelledby="days">
          <h2 id="days">Daily report (last {DAYS} days, PKT)</h2>
          {r.days.length === 0 ? (
            <p className="empty">No reconciliation run in this period.</p>
          ) : (
            <div className="tbl-wrap">
              <table className="t" data-testid="recon-days">
                <thead>
                  <tr>
                    <th scope="col">Day</th>
                    <th scope="col" className="n">
                      Runs
                    </th>
                    <th scope="col" className="n">
                      Passed
                    </th>
                    <th scope="col" className="n">
                      Failed
                    </th>
                    <th scope="col" className="n">
                      Blocking
                    </th>
                    <th scope="col" className="n">
                      Warnings
                    </th>
                    <th scope="col">Last run</th>
                  </tr>
                </thead>
                <tbody>
                  {r.days.map((d) => (
                    <tr key={d.day}>
                      <td className="mono">{d.day}</td>
                      <td className="n">{int(d.runs)}</td>
                      <td className="n up">{int(d.passed)}</td>
                      <td className={`n ${d.failed + d.error > 0 ? "dn" : ""}`}>{int(d.failed + d.error)}</td>
                      <td className={`n ${d.blocking > 0 ? "dn" : ""}`}>{int(d.blocking)}</td>
                      <td className="n">{int(d.warnings)}</td>
                      <td className="mono">
                        <a href={`/trustee/recon/${String(d.last)}`}>#{d.last}</a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="card" aria-labelledby="gate">
          <h2 id="gate">Payout gate</h2>
          <dl className="kv">
            <dt>Payouts</dt>
            <dd>
              <span className={r.gate.allowed ? "chip ok" : "chip bad"}>{r.gate.allowed ? "allowed" : r.gate.frozen ? "frozen" : "closed"}</span>
            </dd>
            <dt>Reason</dt>
            <dd>{r.gate.reason}</dd>
            <dt>Last run</dt>
            <dd>
              {r.gate.lastRun ? `#${String(r.gate.lastRun)} ${r.gate.lastStatus ?? ""} · ${pkt(r.gate.lastFinished)}` : "–"}
            </dd>
          </dl>
          <p className="small di">Unfreezing is a two-officer decision of the platform (operations portal); the trustee reads the evidence here.</p>
        </section>
      </div>
      <section className="card" aria-labelledby="runs">
        <h2 id="runs">Latest runs</h2>
        {r.runs.length === 0 ? (
          <p className="empty">No run yet.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="t" data-testid="recon-runs">
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Status</th>
                  <th scope="col">Pinned block</th>
                  <th scope="col" className="n">
                    Blocking
                  </th>
                  <th scope="col" className="n">
                    Warnings
                  </th>
                  <th scope="col">Finished</th>
                  <th scope="col">Started by</th>
                </tr>
              </thead>
              <tbody>
                {r.runs.map((x) => (
                  <tr key={x.id}>
                    <td className="mono">
                      <a href={`/trustee/recon/${String(x.id)}`}>#{x.id}</a>
                    </td>
                    <td>
                      <span className={stateChip(x.status === "passed" ? "done" : x.status === "running" ? "open" : "failed")}>{x.status}</span>
                    </td>
                    <td className="mono">{x.pinnedBlock !== null ? `#${String(x.pinnedBlock)}` : "–"}</td>
                    <td className="n">{int(x.blocking)}</td>
                    <td className="n">{int(x.warnings)}</td>
                    <td className="small">{pkt(x.finishedAt)}</td>
                    <td className="mono small">{x.startedBy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Shell>
  );
}
