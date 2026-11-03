import type { Metadata } from "next";
import { ComplianceTabs } from "@/components/ComplianceTabs";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { pkt } from "@/lib/format";
import { countryName, residencyList, stateChip } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Residency (RDA)" };

/**
 * Non-resident investors (spec S-08, migration 0056): reviews of their residency (two compliance
 * officers: propose, then confirm by a second; reject revokes) and the non-residents with their
 * payout account kind and the credits sent to suspense because they did not come from their RDA.
 */
export default async function ResidencyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("compliance.read", "/compliance/residency");
  const q = await searchParams;
  const r = await residencyList(officer.sessionHash);

  return (
    <Shell officer={officer} current="/compliance/freezes" title="Residency (Roshan Digital Account)">
      <ComplianceTabs current="/compliance/residency" />
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="rev">
          <h2 id="rev">Reviews</h2>
          <p className="di small">A non-resident reads &quot;review&quot; (not verified) until two different compliance officers approve. Money in and out only through their RDA.</p>
          {r.reviews.length === 0 ? (
            <p className="empty">No residency review yet.</p>
          ) : (
            <div className="tbl-wrap">
              <table className="t" data-testid="residency-reviews">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Investor</th>
                    <th scope="col">Document</th>
                    <th scope="col">Lives in</th>
                    <th scope="col">State</th>
                    <th scope="col">Opened</th>
                  </tr>
                </thead>
                <tbody>
                  {r.reviews.map((v) => (
                    <tr key={v.id}>
                      <td className="mono">
                        <a href={`/compliance/residency/${String(v.id)}`}>#{v.id}</a>
                      </td>
                      <td className="mono">{v.ref}</td>
                      <td>{v.document.toUpperCase()}</td>
                      <td>{countryName(v.country)}</td>
                      <td>
                        <span className={stateChip(v.status)}>{v.status}</span>
                      </td>
                      <td className="mono small">{pkt(v.openedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="card" aria-labelledby="nr">
          <h2 id="nr">Non-resident investors ({r.investors.length})</h2>
          {r.investors.length === 0 ? (
            <p className="empty">No non-resident investor.</p>
          ) : (
            <div className="tbl-wrap">
              <table className="t" data-testid="residency-investors">
                <thead>
                  <tr>
                    <th scope="col">Investor</th>
                    <th scope="col">KYC</th>
                    <th scope="col">Lives in</th>
                    <th scope="col">Payout account</th>
                    <th scope="col">Credits not from the RDA</th>
                  </tr>
                </thead>
                <tbody>
                  {r.investors.map((x) => (
                    <tr key={x.ref}>
                      <td className="mono">{x.ref}</td>
                      <td>
                        <span className={stateChip(x.status)}>{x.status}</span>
                      </td>
                      <td>{countryName(x.country)}</td>
                      <td>{x.payoutKind ? `${x.payoutKind === "rda" ? "RDA" : "domestic (not paid)"}${x.payoutActive ? "" : " · not active"}` : "none"}</td>
                      <td>{x.suspense > 0 ? <a href="/operations/bank">{x.suspense} in suspense</a> : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </Shell>
  );
}
