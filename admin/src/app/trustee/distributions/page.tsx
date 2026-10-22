import type { Metadata } from "next";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { TrusteeTabs } from "@/components/TrusteeTabs";
import { pkt, short } from "@/lib/format";
import { rupees } from "@/lib/server/approvals";
import { stateChip } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";
import { distributions } from "@/lib/server/trustee";

export const metadata: Metadata = { title: "Distributions" };

/**
 * Rent distributions from the read model (spec S-03 D4/D6). While a distribution is published and
 * inside its 48-hour challenge window the trustee approves (with the Merkle root it recomputed) or
 * rejects it with a reason; a rejection blocks its booking and payout in the database.
 */
export default async function DistributionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("trustee.read", "/trustee/distributions");
  const q = await searchParams;
  const rows = await distributions(officer.sessionHash);

  return (
    <Shell officer={officer} current="/trustee/distributions" title="Distributions">
      <TrusteeTabs current="/trustee/distributions" />
      <Flash q={q} />
      <section className="card" aria-labelledby="list">
        <h2 id="list">Distributions (newest first)</h2>
        {rows.length === 0 ? (
          <p className="empty">No distribution in the read model yet.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="t" data-testid="distributions">
              <thead>
                <tr>
                  <th scope="col">Id</th>
                  <th scope="col">Token</th>
                  <th scope="col" className="n">
                    Total
                  </th>
                  <th scope="col">On chain</th>
                  <th scope="col">Window closes</th>
                  <th scope="col">Trustee</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={`${d.registry}:${d.id}`}>
                    <td className="mono">
                      <a href={`/trustee/distributions/${d.registry}/${d.id}`}>#{d.id}</a>
                    </td>
                    <td className="mono small">{short(d.token)}</td>
                    <td className="n mono">{rupees(d.totalPaisa)}</td>
                    <td>
                      <span className={stateChip(d.status === "published" ? "open" : d.status === "paid" ? "done" : d.status)}>{d.status}</span>
                    </td>
                    <td className="small">
                      {pkt(d.windowCloses)} {d.windowOpen ? <span className="chip warn">open</span> : null}
                    </td>
                    <td>
                      {d.review ? (
                        <span className={d.review.decision === "approve" ? "chip ok" : "chip bad"}>
                          {d.review.decision === "approve" ? "approved" : "rejected"} · {d.review.by}
                        </span>
                      ) : d.windowOpen ? (
                        <span className="chip warn">review due</span>
                      ) : (
                        "–"
                      )}
                    </td>
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
