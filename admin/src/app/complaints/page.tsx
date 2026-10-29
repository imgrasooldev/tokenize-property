import type { Metadata } from "next";
import { Shell } from "@/components/Shell";
import { pkt } from "@/lib/format";
import { complaints } from "@/lib/server/complaints";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Complaints" };

/** Investor complaints (migration 0040): open ones first by resolution deadline, late ones flagged. */
export default async function ComplaintsPage() {
  const officer = await requirePage("complaints.read", "/complaints");
  const rows = await complaints(officer.sessionHash);
  const open = rows.filter((r) => r.status === "open" || r.status === "acknowledged");
  return (
    <Shell officer={officer} current="/complaints" title="Complaints">
      <div className="kpis">
        <div className="kpi">
          <div className="label">Open</div>
          <div className="val">{open.length}</div>
          <div className="sub">open or acknowledged</div>
        </div>
        <div className="kpi">
          <div className="label">Late</div>
          <div className="val">{open.filter((r) => r.ackLate || r.resolveLate).length}</div>
          <div className="sub">past a deadline</div>
        </div>
      </div>
      <section className="card" aria-labelledby="cl">
        <h2 id="cl">All complaints</h2>
        {rows.length === 0 ? (
          <p className="empty">No complaint yet.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="t" data-testid="complaints">
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Category</th>
                  <th scope="col">Title</th>
                  <th scope="col">Status</th>
                  <th scope="col">Resolve by</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">
                      <a href={`/complaints/${String(r.id)}`}>{r.ref}</a>
                    </td>
                    <td>{r.category}</td>
                    <td>{r.title}</td>
                    <td>
                      <span className={`chip ${r.status === "resolved" || r.status === "closed" ? "ok" : r.status === "referred" ? "warn" : ""}`}>{r.status}</span>
                      {r.ackLate ? <span className="chip bad">acknowledgement late</span> : null}
                      {r.resolveLate ? <span className="chip bad">late</span> : null}
                    </td>
                    <td className="small">{pkt(r.resolveDue)}</td>
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
