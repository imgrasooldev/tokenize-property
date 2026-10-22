import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActionPanel } from "@/components/ActionPanel";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { TrusteeTabs } from "@/components/TrusteeTabs";
import { pkt, short } from "@/lib/format";
import { stateChip } from "@/lib/server/compliance";
import { UUID } from "@/lib/server/compliance-route";
import { requirePage } from "@/lib/server/session";
import { units } from "@/lib/server/trustee";
import { propertyName, rupees, trusteeProperty } from "@/lib/server/votes";

export const metadata: Metadata = { title: "Property for the trust" };

/**
 * The trustee's acceptance of a property (S-01 P8, OB-37; migration 0026): the latest structure
 * (kind, unit rights, planned register and the MaxBalance limit derived from it, trust deed hash),
 * the committee's approval and minutes hash, valuations and current documents. A trustee officer
 * accepts or declines it with a reason (and optional conditions), bound to the digest of this page;
 * a structure is decided once.
 */
export default async function TrusteePropertyPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const valid = UUID.test(id);
  const officer = await requirePage("trustee.read", `/trustee/properties/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const p = await trusteeProperty(officer.sessionHash, id);
  if (!p) notFound();
  const s = p.structure;

  return (
    <Shell officer={officer} current="/trustee/properties" title={propertyName(p.property)}>
      <TrusteeTabs current="/trustee/properties" />
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="prop">
          <h2 id="prop">
            Property <span className="sp" />
            <span className={stateChip(p.property.state)} data-testid="property-state">
              {p.property.state}
            </span>
          </h2>
          <dl className="kv">
            <dt>Property</dt>
            <dd className="mono small">{p.property.id}</dd>
            <dt>Location</dt>
            <dd>{[p.property.district, p.property.province].filter(Boolean).join(", ") || "–"}</dd>
            <dt>Use</dt>
            <dd>{p.property.use ?? "–"}</dd>
            <dt>Sponsor KYB</dt>
            <dd>{p.property.sponsorState ?? "–"}</dd>
            <dt>Valuations</dt>
            <dd>
              {p.valuation.count} · lowest {rupees(p.valuation.lowestPaisa)} · {p.valuation.ok ? "within tolerance" : (p.valuation.problem ?? "not valid")}
            </dd>
            <dt>Digest</dt>
            <dd className="mono small">{p.digest}</dd>
          </dl>
        </section>
        <section className="card" aria-labelledby="ic">
          <h2 id="ic">Investment committee</h2>
          {p.committee ? (
            <dl className="kv">
              <dt>Meeting</dt>
              <dd className="mono">
                #{p.committee.id} · chair {p.committee.chair}
              </dd>
              <dt>Approved</dt>
              <dd>{pkt(p.committee.closedAt)}</dd>
              <dt>Votes · approvals</dt>
              <dd className="mono">
                {p.committee.votes} · {p.committee.approvals}
              </dd>
              <dt>Minutes SHA-256</dt>
              <dd className="mono small">{p.committee.minutesSha256}</dd>
            </dl>
          ) : (
            <p className="empty">No approved committee meeting.</p>
          )}
        </section>
      </div>

      <section className="card" aria-labelledby="structure">
        <h2 id="structure">Structure (OB-35, OB-36)</h2>
        {s ? (
          <dl className="kv" data-testid="structure">
            <dt>Structure</dt>
            <dd className="mono">
              #{s.id} · {s.kind.toUpperCase()}
              {s.shariah ? " · Shariah-compliant" : " · conventional"}
            </dd>
            <dt>Planned register</dt>
            <dd className="mono">{units(s.plannedUnits)} units</dd>
            <dt>Max holding (MaxBalance)</dt>
            <dd className="mono">
              {units(s.maxHoldingUnits)} units ({(s.maxBalanceBp / 100).toFixed(2)} %)
            </dd>
            {Object.entries(s.unitRights).map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <dt>Unit right: {k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
            <dt>Trust deed SHA-256</dt>
            <dd className="mono small">
              {s.trustDeed?.sha256 ?? "–"} {s.trustDeed && !s.trustDeed.current ? <span className="chip bad">superseded</span> : null}
            </dd>
            <dt>Decided by (legal head)</dt>
            <dd className="mono">
              {s.decidedBy} · {pkt(s.at)}
            </dd>
          </dl>
        ) : (
          <p className="empty">The legal head has not recorded the structure yet.</p>
        )}
      </section>

      <div className="g2">
        <section className="card" aria-labelledby="docs">
          <h2 id="docs">Current documents</h2>
          <div className="tbl-wrap">
            <table className="t" data-testid="property-documents">
              <thead>
                <tr>
                  <th scope="col">Type</th>
                  <th scope="col">SHA-256</th>
                </tr>
              </thead>
              <tbody>
                {p.documents.map((d) => (
                  <tr key={d.id}>
                    <td>{d.type}</td>
                    <td className="mono small" title={d.sha256}>
                      {short(d.sha256, 10)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="card" aria-labelledby="dec">
          <h2 id="dec">Trustee decision</h2>
          {p.decisions.length > 0 ? (
            <ul className="small" data-testid="trustee-decisions">
              {p.decisions.map((d) => (
                <li key={d.id}>
                  Structure #{d.structure}: <b>{d.decision}</b> by <span className="mono">{d.trustee}</span> · {pkt(d.at)} · {d.reason}
                  {d.conditions ? ` · conditions: ${d.conditions}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
          <ActionPanel
            csrf={officer.csrf}
            action={`/api/trustee/properties/${p.property.id}/decide`}
            hidden={{ digest: p.digest, structure: s ? String(s.id) : "" }}
            actions={[
              { action: "accept", label: "Accept for the trust with security key", blockers: [...p.blockers, ...p.acceptBlockers], tone: "ok" },
              { action: "decline", label: "Decline with security key", blockers: p.blockers, tone: "no" },
            ]}
            extra={
              <>
                <label className="small mu" htmlFor="conditions">
                  Conditions of the trustee (optional, 10 to 1000 characters)
                </label>
                <textarea id="conditions" name="conditions" maxLength={1000} />
              </>
            }
            note="Accepted: Tokenization Ready. Recorded in the property, trustee and admin audit chains; a structure is decided once."
          />
        </section>
      </div>
    </Shell>
  );
}
