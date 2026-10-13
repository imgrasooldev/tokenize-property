import type { Metadata } from "next";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { pkt, short } from "@/lib/format";
import { inbox, transitionLabel } from "@/lib/server/approvals";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Property and KYB requests" };

/** Open S-01 maker-checker requests (KYB decisions, screening clearances, property rejections and holds). */
export default async function PropertyRequestsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("property.read", "/approvals/property");
  const q = await searchParams;
  const box = await inbox(officer.sessionHash);
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
    </Shell>
  );
}
