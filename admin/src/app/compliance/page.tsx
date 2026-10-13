import type { Metadata } from "next";
import { ComplianceTabs } from "@/components/ComplianceTabs";
import { Shell } from "@/components/Shell";
import { age, int, pkt } from "@/lib/format";
import { actionLabel, dashboard, stateChip } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Compliance" };

const ITEM_PATH: Record<string, string> = { kyc: "/compliance/kyc/", freeze: "/compliance/freezes/", unfreeze: "/compliance/freezes/", str: "/compliance/str/", rescreen: "/compliance/screening#" };
const PATHS = new Map(Object.entries(ITEM_PATH));

function count(m: Record<string, number>, keys: string[]): number {
  return keys.reduce((s, k) => s + (new Map(Object.entries(m)).get(k) ?? 0), 0);
}

/**
 * Compliance dashboard (Step 6c): counts by state, items past their service level (ageing) and the
 * latest decisions. Counts and references only; no personal data.
 */
export default async function CompliancePage() {
  const officer = await requirePage("compliance.read", "/compliance");
  const d = await dashboard(officer.sessionHash);
  const liveKyc = count(d.kycCases, ["open", "info_requested", "pending_second"]);
  const liveStr = count(d.str, ["open", "under_review", "close_proposed"]);
  const now = Date.parse(d.at);
  const states = (m: Record<string, number>) => Object.entries(m).sort(([a], [b]) => a.localeCompare(b));

  return (
    <Shell officer={officer} current="/compliance" title="Compliance">
      <ComplianceTabs current="/compliance" />
      <div className="kpis" data-testid="compliance-kpis">
        <div className="kpi">
          <div className="label">KYC cases open</div>
          <div className="val">{int(liveKyc)}</div>
          <div className="sub">{int(d.highRiskOpen)} high risk · {int(d.kycCases.pending_second ?? 0)} waiting for a 2nd officer</div>
        </div>
        <div className="kpi">
          <div className="label">Freeze requests</div>
          <div className="val">{int(d.freezes.open ?? 0)}</div>
          <div className="sub">open · {int(d.activeHolds)} wallets held</div>
        </div>
        <div className="kpi">
          <div className="label">STR cases</div>
          <div className="val">{int(liveStr)}</div>
          <div className="sub">open · {int(d.str.filed ?? 0)} filed with the FMU</div>
        </div>
        <div className="kpi">
          <div className="label">Re-screenings</div>
          <div className="val">{int(count(d.rescreens, ["queued", "running"]))}</div>
          <div className="sub">queued · {int(d.rescreens.failed ?? 0)} failed</div>
        </div>
        <div className="kpi">
          <div className="label">SLA breaches</div>
          <div className={d.breaches.length > 0 ? "val dn" : "val up"} data-testid="sla-breaches">
            {int(d.breaches.length)}
          </div>
          <div className="sub">items past their service level</div>
        </div>
        <div className="kpi">
          <div className="label">Rule</div>
          <div className="val small" style={{ fontSize: 13 }}>
            High risk = two officers
          </div>
          <div className="sub">step-up &lt; 5 min · reason · audit</div>
        </div>
      </div>

      <div className="g2">
        <section className="card" aria-labelledby="states">
          <h2 id="states">Counts by state</h2>
          <div className="g2">
            {(
              [
                ["Investors (KYC status)", d.kycStatus],
                ["KYC review cases", d.kycCases],
                ["Freeze requests", d.freezes],
                ["STR cases", d.str],
              ] as [string, Record<string, number>][]
            ).map(([title, m]) => (
              <dl className="kv" key={title}>
                <dt>
                  <b>{title}</b>
                </dt>
                <dd />
                {states(m).length === 0 ? (
                  <>
                    <dt className="mu">none</dt>
                    <dd />
                  </>
                ) : (
                  states(m).map(([k, v]) => (
                    <div key={k} style={{ display: "contents" }}>
                      <dt>
                        <span className={stateChip(k)}>{k}</span>
                      </dt>
                      <dd className="mono">{int(v)}</dd>
                    </div>
                  ))
                )}
              </dl>
            ))}
          </div>
        </section>

        <section className="card" aria-labelledby="sla">
          <h2 id="sla">
            Ageing and SLA breaches <span className="sp" />
            <span className="mu small" style={{ fontWeight: 400 }}>
              oldest open: KYC {d.oldestOpen.kyc ? age((now - Date.parse(d.oldestOpen.kyc)) / 1000) : "–"} · freeze{" "}
              {d.oldestOpen.freeze ? age((now - Date.parse(d.oldestOpen.freeze)) / 1000) : "–"} · STR{" "}
              {d.oldestOpen.str ? age((now - Date.parse(d.oldestOpen.str)) / 1000) : "–"}
            </span>
          </h2>
          {d.breaches.length === 0 ? (
            <p className="empty">Nothing is past its service level.</p>
          ) : (
            <div className="tbl-wrap">
              <table className="t" data-testid="breaches">
                <thead>
                  <tr>
                    <th scope="col">Item</th>
                    <th scope="col">State</th>
                    <th scope="col">Since</th>
                    <th scope="col" className="n">
                      Overdue
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.breaches.map((b) => (
                    <tr key={`${b.kind}-${String(b.id)}`}>
                      <td className="mono">
                        <a href={`${PATHS.get(b.kind) ?? "/compliance#"}${String(b.id)}`}>
                          {b.kind} #{b.id}
                        </a>{" "}
                        {b.risk === "high" ? <span className="chip bad">high</span> : null}
                      </td>
                      <td>
                        <span className={stateChip(b.state)}>{b.state}</span>
                      </td>
                      <td className="small">{pkt(b.since)}</td>
                      <td className="n dn">{age(b.overdueSeconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="di small" style={{ marginBlockStart: 8 }}>
            Service levels: KYC open 48 h, waiting for a second officer 24 h, information requested 7 d; freeze request 4 h; STR open 3 d, under review 7 d;
            re-screening 1 h.
          </p>
        </section>
      </div>

      <section className="card" aria-labelledby="recent">
        <h2 id="recent">Recent decisions</h2>
        {d.recent.length === 0 ? (
          <p className="empty">No decision yet.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="t" data-testid="recent-decisions">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Item</th>
                  <th scope="col">Action</th>
                  <th scope="col">Result</th>
                  <th scope="col">Officer</th>
                </tr>
              </thead>
              <tbody>
                {d.recent.map((r, i) => (
                  <tr key={`${r.kind}-${String(r.id)}-${String(i)}`}>
                    <td className="small">{pkt(r.at)}</td>
                    <td className="mono">
                      <a href={`${PATHS.get(r.kind) ?? "/compliance#"}${String(r.id)}`}>
                        {r.kind} #{r.id}
                      </a>
                    </td>
                    <td>{actionLabel(r.action)}</td>
                    <td>
                      <span className={stateChip(r.to)}>{r.to}</span>
                    </td>
                    <td className="mono small">{r.actor}</td>
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
