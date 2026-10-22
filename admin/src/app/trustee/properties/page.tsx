import type { Metadata } from "next";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { TrusteeTabs } from "@/components/TrusteeTabs";
import { pkt } from "@/lib/format";
import { stateChip } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";
import { units } from "@/lib/server/trustee";
import { propertyName, trusteeProperties } from "@/lib/server/votes";

export const metadata: Metadata = { title: "Property acceptance" };

/**
 * Properties the investment committee approved (Legal Approved) waiting for the trustee's acceptance
 * (S-01 P8, OB-37; migration 0026), and the latest trustee decisions.
 */
export default async function TrusteePropertiesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("trustee.read", "/trustee/properties");
  const q = await searchParams;
  const v = await trusteeProperties(officer.sessionHash);
  return (
    <Shell officer={officer} current="/trustee/properties" title="Property acceptance">
      <TrusteeTabs current="/trustee/properties" />
      <Flash q={q} />
      <section className="card" aria-labelledby="waiting">
        <h2 id="waiting">
          Waiting for the trustee <span className="sp" />
          <span className="mu small" style={{ fontWeight: 400 }}>
            spec S-01 P8 · the trustee accepts the property, the structure, the documents and the register size
          </span>
        </h2>
        {v.waiting.length === 0 ? (
          <p className="empty">No property is waiting for the trustee.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="t" data-testid="trustee-properties">
              <thead>
                <tr>
                  <th scope="col">Property</th>
                  <th scope="col">Structure</th>
                  <th scope="col" className="n">
                    Register (units)
                  </th>
                  <th scope="col">Legal Approved since</th>
                  <th scope="col">Can decide</th>
                </tr>
              </thead>
              <tbody>
                {v.waiting.map((w) => (
                  <tr key={w.property.id}>
                    <td>
                      <a href={`/trustee/properties/${w.property.id}`}>{propertyName(w.property)}</a>
                    </td>
                    <td>
                      {w.structure ? (
                        <>
                          #{w.structure.id} {w.structure.kind.toUpperCase()}
                          {w.structure.shariah ? " · Shariah" : ""} {w.structure.decided ? <span className="chip bad">declined</span> : null}
                        </>
                      ) : (
                        <span className="chip warn">no structure yet</span>
                      )}
                    </td>
                    <td className="n mono">{units(w.structure?.plannedUnits)}</td>
                    <td className="mono small">{pkt(w.since)}</td>
                    <td>{w.blockers.length === 0 ? <span className="chip ok">yes</span> : <span className="chip">no</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card" aria-labelledby="recent">
        <h2 id="recent">Latest trustee decisions</h2>
        {v.recent.length === 0 ? (
          <p className="empty">No decision yet.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="t" data-testid="trustee-property-decisions">
              <thead>
                <tr>
                  <th scope="col">Property</th>
                  <th scope="col">Structure</th>
                  <th scope="col">Decision</th>
                  <th scope="col">Trustee officer</th>
                  <th scope="col">At</th>
                </tr>
              </thead>
              <tbody>
                {v.recent.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <a href={`/trustee/properties/${d.property.id}`}>{propertyName(d.property)}</a>
                    </td>
                    <td className="mono">#{d.structure}</td>
                    <td>
                      <span className={stateChip(d.decision === "accept" ? "approved" : "rejected")}>{d.decision}</span>
                    </td>
                    <td className="mono small">{d.trustee}</td>
                    <td className="mono small">{pkt(d.at)}</td>
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
