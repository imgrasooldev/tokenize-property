import type { Metadata } from "next";
import { Shell } from "@/components/Shell";
import { short, utc } from "@/lib/format";
import { transferAudit } from "@/lib/server/transfers";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Transfer audit trail" };

const PAGE = 50;

/**
 * The transfer audit chain (transfer.audit, hash-chained, newest first) and its verification by the
 * database (transfer.verify_audit): every opening, acceptance, completion, check run, decision,
 * command, payment, cash operation, price, conflict, link, block and setting change.
 */
export default async function TransferAuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("transfer.read", "/transfers/audit");
  const q = await searchParams;
  const before = typeof q.before === "string" && /^[1-9]\d{0,17}$/.test(q.before) ? q.before : null;
  const a = await transferAudit(officer.sessionHash, before, PAGE);
  const last = a.rows.at(-1);

  return (
    <Shell officer={officer} current="/transfers" title="Transfer audit trail">
      <nav className="tabs" aria-label="Transfers">
        <a href="/transfers">Cases</a>
        <a href="/transfers/audit" aria-current="page">
          Audit trail
        </a>
      </nav>
      <section className="card" aria-labelledby="chain">
        <h2 id="chain">
          Transfer chain <span className="sp" />
          <span className={a.problems === 0 ? "chip ok" : "chip bad"} data-testid="chain-state">
            {a.problems === 0 ? "Intact ✓" : `BROKEN (${String(a.problems)})`}
          </span>
        </h2>
        {a.firstProblem ? <p className="alert bad">{a.firstProblem}</p> : null}
        {a.rows.length === 0 ? (
          <p className="empty">No entry.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="t" data-testid="transfer-audit">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">At (UTC)</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Action</th>
                  <th scope="col">Detail</th>
                  <th scope="col">Hash</th>
                </tr>
              </thead>
              <tbody>
                {a.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.id}</td>
                    <td className="mono small">{utc(r.at)}</td>
                    <td className="mono small">{r.actor}</td>
                    <td className="mono small">{r.action}</td>
                    <td className="mono small">{JSON.stringify(r.detail).slice(0, 240)}</td>
                    <td className="mono small">{short(r.hash, 8)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {last && a.rows.length === PAGE ? (
          <p className="small" style={{ marginBlockStart: 8 }}>
            <a href={`/transfers/audit?before=${String(last.id)}`}>Older entries</a>
          </p>
        ) : null}
      </section>
    </Shell>
  );
}
