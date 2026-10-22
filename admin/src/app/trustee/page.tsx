import type { Metadata } from "next";
import { GateChip } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { TrusteeTabs } from "@/components/TrusteeTabs";
import { int, pkt, short } from "@/lib/format";
import { requirePage } from "@/lib/server/session";
import { trusteeDashboard, units } from "@/lib/server/trustee";

export const metadata: Metadata = { title: "Trustee" };

/**
 * Trustee overview (Step 6d, ADR 0011 section 12). Officers of the independent trustee (e.g. CDC)
 * hold no platform role. Everything here is read from the database by admin.trustee_dashboard:
 * work waiting for the trustee, the register against the chain read model (pinned to the
 * indexer's cursor block), supply against the trustee cap, and the reconciliation gate.
 */
export default async function TrusteePage() {
  const officer = await requirePage("trustee.read", "/trustee");
  const d = await trusteeDashboard(officer.sessionHash);
  const tokensWithDiff = d.tokens.filter((t) => t.differences > 0 || t.supply !== t.registerTotal).length;

  return (
    <Shell officer={officer} current="/trustee" title="Trustee" actions={<GateChip gate={d.gate} />}>
      <TrusteeTabs current="/trustee" />
      <div className="kpis" data-testid="trustee-kpis">
        <div className="kpi">
          <div className="label">Co-signatures waiting</div>
          <div className="val">{int(d.cosignSigner + d.cosignOffering + d.cosignCharges + d.prechecks)}</div>
          <div className="sub">
            <a href="/trustee/cosign">
              {int(d.cosignSigner)} signing Â· {int(d.cosignOffering)} offering
            </a>
          </div>
        </div>
        <div className="kpi">
          <div className="label">Distributions in the 48 h window</div>
          <div className={`val ${d.distributionsInWindow > 0 ? "warn" : ""}`}>{int(d.distributionsInWindow)}</div>
          <div className="sub">
            <a href="/trustee/distributions">not reviewed yet</a>
            {d.rejectedNotOnChain > 0 ? <span className="chip bad">{int(d.rejectedNotOnChain)} rejected, not yet on chain</span> : null}
          </div>
        </div>
        <div className="kpi">
          <div className="label">Register differences</div>
          <div className={`val ${tokensWithDiff > 0 ? "dn" : "up"}`} data-testid="register-state">
            {tokensWithDiff > 0 ? `${int(tokensWithDiff)} token(s)` : "None âœ“"}
          </div>
          <div className="sub">
            <a href="/trustee/register">register vs chain read model</a> Â· {int(d.openAdjustments)} adjustment(s) open
          </div>
        </div>
        <div className="kpi">
          <div className="label">Latest reconciliation</div>
          <div className={`val ${d.latestRun?.status === "passed" ? "up" : "dn"}`}>{d.latestRun ? d.latestRun.status : "none"}</div>
          <div className="sub">
            {d.latestRun ? (
              <a href={`/trustee/recon/${String(d.latestRun.id)}`}>
                run #{d.latestRun.id} Â· {pkt(d.latestRun.finishedAt)}
              </a>
            ) : (
              "no run yet"
            )}
          </div>
        </div>
        <div className="kpi">
          <div className="label">Recovery requests</div>
          <div className="val">{int(d.pendingRecoveries)}</div>
          <div className="sub">
            <a href="/trustee/recoveries">pending on chain</a>
          </div>
        </div>
        <div className="kpi">
          <div className="label">Rule</div>
          <div className="val small" style={{ fontSize: 13 }}>
            Trustee officers only
          </div>
          <div className="sub">step-up &lt; 5 min Â· reason Â· digest Â· audit</div>
        </div>
      </div>

      <section className="card" aria-labelledby="tokens">
        <h2 id="tokens">Supply, trustee cap and register</h2>
        {d.tokens.length === 0 ? (
          <p className="empty">No token in the read model yet.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="t" data-testid="trustee-tokens">
              <thead>
                <tr>
                  <th scope="col">Token</th>
                  <th scope="col" className="n">
                    Supply
                  </th>
                  <th scope="col" className="n">
                    Trustee cap
                  </th>
                  <th scope="col" className="n">
                    Register
                  </th>
                  <th scope="col">State</th>
                  <th scope="col">Pinned block</th>
                </tr>
              </thead>
              <tbody>
                {d.tokens.map((t) => {
                  const differs = t.differences > 0 || t.supply !== t.registerTotal;
                  return (
                    <tr key={t.token}>
                      <td className="mono small">
                        <a href={`/trustee/register?token=${t.token}`}>{short(t.token)}</a> <span className="mu">{t.deployment}</span>
                      </td>
                      <td className="n mono">{units(t.supply)}</td>
                      <td className="n mono">{units(t.cap)}</td>
                      <td className={`n mono ${differs ? "dn" : ""}`}>{units(t.registerTotal)}</td>
                      <td>
                        {differs ? <span className="chip bad">{int(t.differences)} wallet difference(s)</span> : <span className="chip ok">matches</span>}{" "}
                        {BigInt(t.supply) > BigInt(t.cap) ? <span className="chip bad">supply above cap</span> : null} {t.paused ? <span className="chip">paused</span> : null}
                      </td>
                      <td className="mono small">
                        {t.pinned ? `#${String(t.pinned.block)}` : "â€“"} {t.pinned?.halted ? <span className="chip bad">indexer halted</span> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="small di">
          The register is the trustee&apos;s own record: entries written when the trustee confirms an offering&apos;s register entries (V18) and two-officer
          adjustments. Chain numbers come from the indexer&apos;s read model at the pinned block, never from a live chain call.
        </p>
      </section>
    </Shell>
  );
}
