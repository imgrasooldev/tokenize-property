import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Shell } from "@/components/Shell";
import { TrusteeTabs } from "@/components/TrusteeTabs";
import { int, pkt } from "@/lib/format";
import { stateChip } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";
import { reconRun } from "@/lib/server/trustee";

export const metadata: Metadata = { title: "Reconciliation run" };

/** One reconciliation run with its findings and its digest (recon.run_digest), read-only. */
export default async function TrusteeReconRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const valid = /^[1-9]\d{0,17}$/.test(id);
  const officer = await requirePage("trustee.read", `/trustee/recon/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const r = await reconRun(officer.sessionHash, id);
  if (!r) notFound();

  return (
    <Shell officer={officer} current="/trustee/recon" title={`Reconciliation run #${String(r.id)}`}>
      <TrusteeTabs current="/trustee/recon" />
      <div className="g2">
        <section className="card" aria-labelledby="run">
          <h2 id="run">
            Run <span className="sp" />
            <span className={stateChip(r.status === "passed" ? "done" : r.status === "running" ? "open" : "failed")} data-testid="run-status">
              {r.status}
            </span>
          </h2>
          <dl className="kv">
            <dt>Started</dt>
            <dd>
              {pkt(r.startedAt)} · <span className="mono">{r.startedBy}</span>
            </dd>
            <dt>Finished</dt>
            <dd>{pkt(r.finishedAt)}</dd>
            <dt>Deployment</dt>
            <dd className="mono">{r.deployment ?? "–"}</dd>
            <dt>Pinned block</dt>
            <dd className="mono">{r.pinnedBlock !== null ? `#${String(r.pinnedBlock)}` : "–"}</dd>
            <dt>Blocking · warnings</dt>
            <dd>
              {int(r.blocking)} · {int(r.warnings)}
            </dd>
            {r.error ? (
              <>
                <dt>Error</dt>
                <dd className="dn">{r.error}</dd>
              </>
            ) : null}
            <dt>Run digest</dt>
            <dd className="mono small" data-testid="run-digest">
              {r.digest ?? "–"}
            </dd>
          </dl>
        </section>
        <section className="card" aria-labelledby="sum">
          <h2 id="sum">Summary</h2>
          {r.summary ? (
            <dl className="kv">
              {Object.entries(r.summary).map(([k, v]) => (
                <div key={k} style={{ display: "contents" }}>
                  <dt className="mono">{k}</dt>
                  <dd className="mono small">{typeof v === "string" || typeof v === "number" ? String(v) : JSON.stringify(v)}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="empty">No summary.</p>
          )}
        </section>
      </div>
      <section className="card" aria-labelledby="findings">
        <h2 id="findings">
          Findings ({int(r.findingCount)}) {r.findingCount > r.findings.length ? <span className="chip">first {int(r.findings.length)} shown</span> : null}
        </h2>
        {r.findings.length === 0 ? (
          <p className="empty">No finding.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="t" data-testid="recon-findings">
              <thead>
                <tr>
                  <th scope="col">Check</th>
                  <th scope="col">Severity</th>
                  <th scope="col">Subject</th>
                  <th scope="col">Expected</th>
                  <th scope="col">Actual</th>
                </tr>
              </thead>
              <tbody>
                {r.findings.map((f) => (
                  <tr key={f.id}>
                    <td className="mono small">{f.check}</td>
                    <td>
                      <span className={f.severity === "blocking" ? "chip bad" : "chip warn"}>{f.severity}</span>
                    </td>
                    <td className="mono small">{f.subject}</td>
                    <td className="mono small">{f.expected ?? "–"}</td>
                    <td className="mono small">{f.actual ?? "–"}</td>
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
