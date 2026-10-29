import type { Metadata } from "next";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { StepUpForm } from "@/components/StepUp";
import { pkt, short } from "@/lib/format";
import { inbox, propertyRequestOptions, transitionLabel } from "@/lib/server/approvals";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Property and KYB requests" };

/** Open S-01 maker-checker requests (KYB decisions, screening clearances, property rejections and holds). */
export default async function PropertyRequestsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("property.read", "/approvals/property");
  const q = await searchParams;
  const [box, options] = await Promise.all([inbox(officer.sessionHash), propertyRequestOptions(officer.sessionHash)]);
  const list = box.property ?? [];
  return (
    <Shell officer={officer} current="/approvals/property" title="Property and KYB requests">
      <Flash q={q} />
      <section className="card" aria-labelledby="open">
        <h2 id="open">
          Open requests <span className="sp" />
          <span className="mu small" style={{ fontWeight: 400 }}>
            spec S-01 · decided by a different officer with the required duty
          </span>
        </h2>
        {list.length === 0 ? (
          <p className="empty">No open request.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="t" data-testid="property-requests">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Decision</th>
                  <th scope="col">File</th>
                  <th scope="col">Transition</th>
                  <th scope="col">Requested by</th>
                  <th scope="col">Expires</th>
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">
                      <a href={`/approvals/property/${String(p.id)}`}>{p.id}</a>
                    </td>
                    <td>
                      <b>{transitionLabel(p.code)}</b> <span className="mono di small">{p.code}</span>
                    </td>
                    <td className="mono small">
                      {p.entity} {short(p.entityId.replace(/-/g, ""), 4)}
                    </td>
                    <td className="mono small">
                      {p.fromState} → {p.toState ?? "(clearance)"}
                    </td>
                    <td className="mono small">{p.requestedBy}</td>
                    <td className={p.expired ? "dn small" : "mono small"}>{p.expired ? "expired" : pkt(p.expiresAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {options.sponsors.length + options.properties.length > 0 ? (
        <section className="card" aria-labelledby="ask" style={{ marginBlockStart: 16 }} data-testid="property-request-form">
          <h2 id="ask">Ask for a decision</h2>
          <p className="small mu">
            KYB approval or rejection and reinstatement need a compliance duty; a property rejection the assigned reviewer of that discipline; the outcome of a hold a legal duty.
            The database checks the duty; a different officer decides.
          </p>
          <StepUpForm csrf={officer.csrf} action="/api/approvals/property/request">
            <div className="row">
              <label className="sr-only" htmlFor="target">
                File
              </label>
              <select id="target" name="target" required>
                {options.sponsors.map((s) => (
                  <option key={s.id} value={`sponsor:${s.id}`}>
                    Sponsor {short(s.id)} ({s.state}): {(s.codes ?? []).join(", ")}
                  </option>
                ))}
                {options.properties.map((p) => (
                  <option key={p.id} value={`property:${p.id}`}>
                    Property {p.building ?? p.district ?? short(p.id)} ({p.state}): {(p.codes ?? []).join(", ")}
                  </option>
                ))}
              </select>
              <label className="sr-only" htmlFor="code">
                Decision
              </label>
              <select id="code" name="code" required>
                {["K4", "K5", "K10", "K11", "P6", "P13", "P14"].map((c) => (
                  <option key={c} value={c}>
                    {c} {transitionLabel(c)}
                  </option>
                ))}
              </select>
            </div>
            <label htmlFor="reason">Reason</label>
            <textarea id="reason" name="reason" required minLength={10} maxLength={500} />
            <div className="row">
              <label htmlFor="discipline">Discipline (P6)</label>
              <input id="discipline" name="discipline" maxLength={40} />
              <label htmlFor="evidence">Evidence SHA-256 (P13)</label>
              <input id="evidence" name="evidence" className="mono" maxLength={64} />
              <label htmlFor="curable">Curable (P6, P14)</label>
              <select id="curable" name="curable">
                <option value="no">no</option>
                <option value="yes">yes</option>
              </select>
            </div>
            <div className="row">
              <button className="btn" type="submit">
                Ask with security key
              </button>
            </div>
          </StepUpForm>
        </section>
      ) : null}
    </Shell>
  );
}
