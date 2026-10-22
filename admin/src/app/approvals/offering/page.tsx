import type { Metadata } from "next";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { pkt } from "@/lib/format";
import { requirePage } from "@/lib/server/session";
import { codeLabel } from "@/lib/server/trustee";
import { dutyLabel, offeringVotes, propertyName } from "@/lib/server/votes";

export const metadata: Metadata = { title: "Offering approvals" };

/**
 * S-02 requests that still need a platform vote (migration 0026): the offering checker (terms),
 * the legal head (documents), compliance (eligibility and disclosures) and bank operators. The
 * trustee's votes are in Trustee > Co-signing.
 */
export default async function OfferingApprovalsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("offering.read", "/approvals/offering");
  const q = await searchParams;
  const v = await offeringVotes(officer.sessionHash);
  return (
    <Shell officer={officer} current="/approvals/offering" title="Offering approvals">
      <Flash q={q} />
      <section className="card" aria-labelledby="open">
        <h2 id="open">
          Open requests <span className="sp" />
          <span className="mu small" style={{ fontWeight: 400 }}>
            spec S-02 · each needed duty votes once, by a different officer than the requester
          </span>
        </h2>
        {v.open.length === 0 ? (
          <p className="empty">No request needs a platform vote.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="t" data-testid="offering-requests">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Request</th>
                  <th scope="col">Property</th>
                  <th scope="col">Still needed</th>
                  <th scope="col">Requested by</th>
                  <th scope="col">Expires</th>
                </tr>
              </thead>
              <tbody>
                {v.open.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">
                      <a href={`/approvals/offering/${String(r.id)}`}>{r.id}</a>
                    </td>
                    <td>
                      <b>{codeLabel(r.code)}</b> <span className="mono di small">{r.code}</span>
                      {r.mine ? <span className="chip">you voted</span> : null}
                    </td>
                    <td>{propertyName(r.property)}</td>
                    <td className="small">{r.missing.map(dutyLabel).join(", ")}</td>
                    <td className="mono small">{r.requestedBy}</td>
                    <td className={r.expired ? "dn small" : "mono small"}>{r.expired ? "expired" : pkt(r.expiresAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {v.lapsed.length > 0 ? (
        <section className="card" aria-labelledby="lapsed">
          <h2 id="lapsed">Offerings pending approval without a live request</h2>
          <p className="small mu">The approval request expired or was rejected: an officer with an offering duty (not the maker) returns the offering to draft from the request page.</p>
          <ul data-testid="offering-lapsed">
            {v.lapsed.map((l) => (
              <li key={l.request}>
                <a href={`/approvals/offering/${String(l.request)}`}>Request #{l.request}</a> · {propertyName(l.property)} · {l.status}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="card" aria-labelledby="recent">
        <h2 id="recent">Latest platform votes</h2>
        {v.recent.length === 0 ? (
          <p className="empty">No vote yet.</p>
        ) : (
          <ul className="small">
            {v.recent.map((r) => (
              <li key={`${String(r.request)}-${r.officer}`}>
                <a href={`/approvals/offering/${String(r.request)}`}>#{r.request}</a> · <span className="mono">{r.officer}</span> ({dutyLabel(r.duty)}) · {r.approve ? "approved" : "rejected"} ·{" "}
                {pkt(r.at)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </Shell>
  );
}
