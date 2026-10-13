import type { Metadata } from "next";
import { ComplianceTabs } from "@/components/ComplianceTabs";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { pkt } from "@/lib/format";
import { stateChip, strList } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "STR cases" };

/**
 * Suspicious transaction report cases (Step 6c, migration 0019 C-4). Confidential: compliance
 * officers and auditors only, never operations, never the investor (tipping-off, AML Act 2010).
 * Nothing is sent to the FMU automatically: the MLRO files the export by hand.
 */
export default async function StrPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("compliance.read", "/compliance/str");
  const q = await searchParams;
  const s = await strList(officer.sessionHash);
  const canDecide = officer.permissions.has("compliance.decide");

  return (
    <Shell officer={officer} current="/compliance/str" title="STR cases">
      <ComplianceTabs current="/compliance/str" />
      <Flash q={q} />
      <p className="alert bad" role="note">
        Confidential (tipping-off): never discuss an STR case with the investor or with operations staff.
      </p>
      <div className="g2">
        <section className="card" aria-labelledby="cases">
          <h2 id="cases">Cases</h2>
          {s.cases.length === 0 ? (
            <p className="empty">No STR case.</p>
          ) : (
            <div className="tbl-wrap">
              <table className="t" data-testid="str-cases">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Category</th>
                    <th scope="col">Investor</th>
                    <th scope="col">State</th>
                    <th scope="col" className="n">
                      Notes
                    </th>
                    <th scope="col">Opened</th>
                    <th scope="col">FMU ref</th>
                  </tr>
                </thead>
                <tbody>
                  {s.cases.map((c) => (
                    <tr key={c.id}>
                      <td className="mono">
                        <a href={`/compliance/str/${String(c.id)}`}>#{c.id}</a>
                      </td>
                      <td className="mono small">{c.category}</td>
                      <td className="mono small">{c.subject ?? "–"}</td>
                      <td>
                        <span className={stateChip(c.status)}>{c.status.replace("_", " ")}</span> {c.overdue ? <span className="chip bad">overdue</span> : null}
                      </td>
                      <td className="n">{c.notes}</td>
                      <td className="small">
                        <span className="mono">{c.openedBy}</span> · {pkt(c.openedAt)}
                      </td>
                      <td className="mono small">{c.fmuReference ?? "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        {canDecide ? (
          <section className="card" aria-labelledby="open">
            <h2 id="open">Open a case</h2>
            <form method="post" action="/api/compliance/str" className="stack">
              <input type="hidden" name="csrf" value={officer.csrf} />
              <select name="category" aria-label="Category" required defaultValue="">
                <option value="" disabled>
                  Category…
                </option>
                {s.categories.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </select>
              <input name="subject" placeholder="Investor reference (UUID from a KYC case, optional)" aria-label="Investor reference" pattern="[0-9a-f-]{36}" />
              <textarea name="summary" required minLength={20} maxLength={2000} placeholder="What raised the suspicion (no CNIC, IBAN or phone number)" aria-label="Summary" />
              <button className="btn" type="submit">
                Open STR case
              </button>
            </form>
          </section>
        ) : null}
      </div>
    </Shell>
  );
}
