import type { Metadata } from "next";
import { ComplianceTabs } from "@/components/ComplianceTabs";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { int, pkt } from "@/lib/format";
import { screenings, stateChip } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Sanctions & PEP screening" };

const OUTCOMES = ["fail", "review", "error", "pass"] as const;

/**
 * Sanctions and PEP screening results (Step 6c): the latest screening of every investor (hits and
 * possible matches first), the review case it opened, and the re-screening queue. A re-screening is
 * executed by the KYC service against the current lists; this page never sees a name.
 */
export default async function ScreeningPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("compliance.read", "/compliance/screening");
  const q = await searchParams;
  const outcome = typeof q.outcome === "string" && (OUTCOMES as readonly string[]).includes(q.outcome) ? q.outcome : null;
  const s = await screenings(officer.sessionHash, outcome);
  const canDecide = officer.permissions.has("compliance.decide");

  return (
    <Shell officer={officer} current="/compliance/screening" title="Sanctions & PEP screening">
      <ComplianceTabs current="/compliance/screening" />
      <Flash q={q} />
      <nav className="tabs" aria-label="Outcome">
        <a href="/compliance/screening" aria-current={outcome === null ? "page" : undefined}>
          All
        </a>
        {OUTCOMES.map((o) => (
          <a key={o} href={`/compliance/screening?outcome=${o}`} aria-current={outcome === o ? "page" : undefined}>
            {o === "fail" ? "list hits" : o === "review" ? "possible matches" : o === "error" ? "provider errors" : "clear"}
          </a>
        ))}
      </nav>
      <section className="card" aria-labelledby="latest">
        <h2 id="latest">
          Latest screening per investor <span className="sp" />
          <span className="mu small" style={{ fontWeight: 400 }}>
            lists: {s.listVersions.join(", ") || "–"}
          </span>
        </h2>
        {s.rows.length === 0 ? (
          <p className="empty">No screening yet.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="t" data-testid="screenings">
              <thead>
                <tr>
                  <th scope="col">Investor</th>
                  <th scope="col">KYC status</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Reason code</th>
                  <th scope="col" className="n">
                    Score
                  </th>
                  <th scope="col">List</th>
                  <th scope="col">Screened</th>
                  <th scope="col">Case</th>
                  {canDecide ? <th scope="col">Re-screen</th> : null}
                </tr>
              </thead>
              <tbody>
                {s.rows.map((r) => (
                  <tr key={r.checkId}>
                    <td className="mono small">
                      {r.subject} · {r.cnic}
                    </td>
                    <td>
                      <span className={stateChip(r.status)}>{r.status}</span>
                    </td>
                    <td>
                      <span className={r.outcome === "pass" ? "chip ok" : r.outcome === "review" ? "chip warn" : "chip bad"}>{r.outcome}</span>
                    </td>
                    <td className="mono small">{r.reason}</td>
                    <td className="n">{r.score ?? "–"}</td>
                    <td className="mono small">{r.listVersion ?? "–"}</td>
                    <td className="small">{pkt(r.at)}</td>
                    <td className="mono">{r.case ? <a href={`/compliance/kyc/${String(r.case)}`}>#{r.case}</a> : "–"}</td>
                    {canDecide ? (
                      <td>
                        {r.rescreen === "queued" || r.rescreen === "running" ? (
                          <span className="chip warn">{r.rescreen}</span>
                        ) : (
                          <form method="post" action="/api/compliance/rescreen" className="row">
                            <input type="hidden" name="csrf" value={officer.csrf} />
                            <input type="hidden" name="subject" value={r.subjectId} />
                            <input name="reason" required minLength={10} maxLength={500} placeholder="Why (10+ characters)" aria-label={`Reason to re-screen ${r.subject}`} />
                            <button className="btn" type="submit">
                              Re-screen
                            </button>
                          </form>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card" aria-labelledby="queue">
        <h2 id="queue">Re-screening queue ({int(s.queue.length)} latest)</h2>
        {s.queue.length === 0 ? (
          <p className="empty">Nothing queued.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="t" data-testid="rescreen-queue">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Investor</th>
                  <th scope="col">State</th>
                  <th scope="col">Asked by</th>
                  <th scope="col">Asked</th>
                  <th scope="col">Finished</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {s.queue.map((r) => (
                  <tr key={r.id} id={String(r.id)}>
                    <td className="mono">{r.id}</td>
                    <td className="mono small">{r.subject}</td>
                    <td>
                      <span className={stateChip(r.status)}>{r.status}</span>
                    </td>
                    <td className="mono small">{r.requestedBy}</td>
                    <td className="small">{pkt(r.requestedAt)}</td>
                    <td className="small">{pkt(r.finishedAt)}</td>
                    <td className="mono small">{r.result ?? r.error ?? "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="di small" style={{ marginBlockStart: 8 }}>
          The KYC service runs the queue (<span className="mono">npm run kyc:rescreen</span>); a possible match opens a review case by itself.
        </p>
      </section>
    </Shell>
  );
}
