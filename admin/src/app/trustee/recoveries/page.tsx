import type { Metadata } from "next";
import { Shell } from "@/components/Shell";
import { TrusteeTabs } from "@/components/TrusteeTabs";
import { pkt, short } from "@/lib/format";
import { stateChip } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";
import { recoveries, units } from "@/lib/server/trustee";

export const metadata: Metadata = { title: "Recoveries" };

const KIND = new Map([
  ["wallet_recovery", "Wallet recovery"],
  ["forced_transfer", "Forced transfer (heirs, court order)"],
]);

function cell(v: unknown): string {
  if (v === null || v === undefined) return "–";
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
}

/**
 * Recovery and inheritance (spec S-06). Today: the RecoveryGuard requests in the chain read model
 * (proposed, executed or cancelled by the Trustee Safe, 48-hour delay). The S-06 case files appear
 * here once S-06 replaces trustee.recovery_cases_json() (the hook of migration 0023); the portal
 * renders whatever that function returns, so no page change is needed.
 */
export default async function RecoveriesPage() {
  const officer = await requirePage("trustee.read", "/trustee/recoveries");
  const r = await recoveries(officer.sessionHash);
  const caseColumns = r.cases && r.cases.length > 0 ? Object.keys(r.cases[0] ?? {}).slice(0, 8) : [];

  return (
    <Shell officer={officer} current="/trustee/recoveries" title="Recoveries">
      <TrusteeTabs current="/trustee/recoveries" />
      <section className="card" aria-labelledby="cases">
        <h2 id="cases">Recovery and inheritance cases (S-06)</h2>
        {r.cases === null ? (
          <p className="alert info" data-testid="recovery-cases-pending">
            Case files (claims, evidence, maker-checker and trustee decisions) arrive with spec S-06, built in parallel. Until then only the on-chain requests
            below are shown; nothing is invented.
          </p>
        ) : r.cases.length === 0 ? (
          <p className="empty">No case.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="t" data-testid="recovery-cases">
              <thead>
                <tr>
                  {caseColumns.map((c) => (
                    <th key={c} scope="col">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.cases.map((c, i) => (
                  <tr key={cell(c.id ?? i)}>
                    {caseColumns.map((k) => (
                      <td key={k} className="mono small">
                        {cell(new Map(Object.entries(c)).get(k))}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card" aria-labelledby="chain">
        <h2 id="chain">RecoveryGuard requests on chain</h2>
        {r.onChain.length === 0 ? (
          <p className="empty">No recovery request on chain.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="t" data-testid="recoveries">
              <thead>
                <tr>
                  <th scope="col">Id</th>
                  <th scope="col">Kind</th>
                  <th scope="col">From → to</th>
                  <th scope="col" className="n">
                    Units
                  </th>
                  <th scope="col">Evidence</th>
                  <th scope="col">Status</th>
                  <th scope="col">Executable after</th>
                </tr>
              </thead>
              <tbody>
                {r.onChain.map((x) => (
                  <tr key={`${x.guard}:${x.id}`}>
                    <td className="mono">#{x.id}</td>
                    <td>{KIND.get(x.kind) ?? x.kind}</td>
                    <td className="mono small">
                      {short(x.from)} → {short(x.to)}
                    </td>
                    <td className="n mono">{units(x.amount)}</td>
                    <td className="mono small">{short(x.evidenceHash, 8)}</td>
                    <td>
                      <span className={stateChip(x.status === "executed" ? "done" : x.status === "cancelled" ? "failed" : "open")}>{x.status}</span>{" "}
                      {x.executable ? <span className="chip warn">delay passed</span> : null}
                    </td>
                    <td className="small">{pkt(x.eta)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="small di">Proposals, executions and cancellations are Trustee Safe (or Admin Safe) transactions; this portal never sends them.</p>
      </section>
    </Shell>
  );
}
