import type { Metadata } from "next";
import { Shell } from "@/components/Shell";
import { pkt } from "@/lib/format";
import { requirePage } from "@/lib/server/session";
import { STATUS_LABELS, supportLookup } from "@/lib/server/support";

export const metadata: Metadata = { title: "Investor lookup" };

/**
 * Investor support (T-049, migration 0031 PR-4): look up one investor by the 8-character reference
 * they read out. Every lookup is audited by the database. Compliance holds, cases and reasons are
 * never shown; such investors read "refer to compliance" (no tipping-off).
 */
export default async function SupportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("support.read", "/support");
  const q = await searchParams;
  const ref = typeof q.ref === "string" ? q.ref.trim() : "";
  const result = ref ? await supportLookup(officer.sessionHash, ref) : null;

  return (
    <Shell officer={officer} current="/support" title="Investor lookup">
      <section className="card" aria-labelledby="find">
        <h2 id="find">Find an investor</h2>
        <form method="get" action="/support" className="row">
          <label htmlFor="ref">Reference (8 characters)</label>
          <input id="ref" name="ref" required minLength={8} maxLength={8} pattern="[0-9a-fA-F]{8}" defaultValue={ref} autoComplete="off" className="mono" />
          <button className="btn prime" type="submit">
            Look up
          </button>
        </form>
        <p className="mu small">Ask the investor for the reference shown on their account page. Every lookup is recorded in the audit trail.</p>
      </section>

      {result && !result.ok ? (
        <p className="alert bad" role="alert">
          {result.error}
        </p>
      ) : null}
      {result?.ok && !result.found ? (
        <p className="alert warn" role="status" data-testid="support-none">
          {result.ambiguous ? "More than one investor matches: refer the caller to compliance." : "No investor has this reference."}
        </p>
      ) : null}
      {result?.ok && result.found ? (
        <section className="card" aria-labelledby="inv" data-testid="support-investor">
          <h2 id="inv">Investor {result.investor.ref}</h2>
          <dl className="kv">
            <dt>CNIC</dt>
            <dd className="mono">{result.investor.cnic}</dd>
            <dt>Status</dt>
            <dd data-testid="support-status">{STATUS_LABELS[result.investor.status]}</dd>
            <dt>Investor since</dt>
            <dd>{pkt(result.investor.since)}</dd>
            <dt>Wallet</dt>
            <dd className="mono small">{result.investor.wallet ?? "none yet"}</dd>
          </dl>
          <h3>Recent notices</h3>
          {result.investor.notices.length === 0 ? (
            <p className="empty">No notice sent yet.</p>
          ) : (
            <div className="tbl-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th scope="col">Notice</th>
                    <th scope="col">Category</th>
                    <th scope="col">Delivery</th>
                    <th scope="col">Sent</th>
                  </tr>
                </thead>
                <tbody>
                  {result.investor.notices.map((n, i) => (
                    <tr key={`${n.at}-${String(i)}`}>
                      <td className="mono small">{n.kind}</td>
                      <td className="small">{n.category}</td>
                      <td className="small">{n.status}</td>
                      <td className="small">{pkt(n.at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </Shell>
  );
}
