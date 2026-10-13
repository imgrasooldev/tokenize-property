import type { Metadata } from "next";
import { ComplianceTabs } from "@/components/ComplianceTabs";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { pkt } from "@/lib/format";
import { CASE_STATES, caseKindLabel, kycQueue, stateChip } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "KYC reviews" };

/**
 * KYC review queue (Step 6c): live cases first (high risk on top, oldest first), or one state. A
 * possible sanctions or PEP match opens a case by itself; officers open manual cases from an
 * investor's case or screening row. Subjects appear as a short reference and a masked CNIC only.
 */
export default async function KycQueuePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("compliance.read", "/compliance/kyc");
  const q = await searchParams;
  const status = typeof q.status === "string" && (CASE_STATES as readonly string[]).includes(q.status) ? q.status : null;
  const rows = await kycQueue(officer.sessionHash, status);

  return (
    <Shell officer={officer} current="/compliance/kyc" title="KYC reviews">
      <ComplianceTabs current="/compliance/kyc" />
      <Flash q={q} />
      <nav className="tabs" aria-label="Case state">
        <a href="/compliance/kyc" aria-current={status === null ? "page" : undefined}>
          Live
        </a>
        {CASE_STATES.map((s) => (
          <a key={s} href={`/compliance/kyc?status=${s}`} aria-current={status === s ? "page" : undefined}>
            {s.replace("_", " ")}
          </a>
        ))}
      </nav>
      <section className="card" aria-labelledby="queue">
        <h2 id="queue">
          {status ? `Cases: ${status.replace("_", " ")}` : "Cases needing a decision"} <span className="sp" />
          <span className="mu small" style={{ fontWeight: 400 }}>
            high risk (PEP, sanctions) needs two different compliance officers
          </span>
        </h2>
        {rows.length === 0 ? (
          <p className="empty">No case in this state.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="t" data-testid="kyc-queue">
              <thead>
                <tr>
                  <th scope="col">Case</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Investor</th>
                  <th scope="col">Risk</th>
                  <th scope="col">State</th>
                  <th scope="col">Opened</th>
                  <th scope="col">Last change</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">
                      <a href={`/compliance/kyc/${String(r.id)}`}>#{r.id}</a>
                    </td>
                    <td>
                      {caseKindLabel(r.kind)}{" "}
                      {r.flags.includes("pep") ? <span className="chip warn">PEP</span> : null}
                    </td>
                    <td className="mono small">
                      {r.subject} · {r.cnic}
                    </td>
                    <td>
                      <span className={r.risk === "high" ? "chip bad" : "chip"}>{r.risk}</span>
                    </td>
                    <td>
                      <span className={stateChip(r.status)}>{r.status.replace("_", " ")}</span>{" "}
                      {r.waitingForMe ? <span className="chip cy">needs a 2nd officer</span> : null}
                      {r.overdue ? <span className="chip bad">overdue</span> : null}
                    </td>
                    <td className="small">{pkt(r.openedAt)}</td>
                    <td className="small">{pkt(r.updatedAt)}</td>
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
