import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DecisionPanel, Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { TrusteeTabs } from "@/components/TrusteeTabs";
import { int, pkt } from "@/lib/format";
import { rupees } from "@/lib/server/approvals";
import { stateChip } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";
import { trusteeCalculation, units } from "@/lib/server/trustee";

export const metadata: Metadata = { title: "Distribution pre-check" };

/**
 * The trustee's pre-check of a distribution calculation (S-03 D4, migration 0023 T-8): recompute
 * the Merkle root independently from the record block and the statement; the operations checker
 * approves only after the trustee approved with a root equal to the attached one.
 */
export default async function TrusteeCalculationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const valid = /^[1-9]\d{0,17}$/.test(id);
  const officer = await requirePage("trustee.read", `/trustee/cosign/calculation/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const d = await trusteeCalculation(officer.sessionHash, id);
  if (!d) notFound();

  return (
    <Shell officer={officer} current="/trustee/cosign" title={`Calculation #${String(d.id)}`}>
      <TrusteeTabs current="/trustee/cosign" />
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="calc">
          <h2 id="calc">
            Rent distribution {d.period} <span className="sp" />
            <span className={stateChip(d.status === "booked" ? "done" : d.status === "returned" ? "failed" : "open")} data-testid="calculation-status">
              {d.status}
            </span>
          </h2>
          <dl className="kv">
            <dt>Token</dt>
            <dd className="mono small">{d.token}</dd>
            <dt>Record date · block</dt>
            <dd className="mono">
              {d.recordDate} · #{d.recordBlock}
            </dd>
            <dt>Income type</dt>
            <dd className="mono">{d.incomeType}</dd>
            <dt>Collected · expenses · fees</dt>
            <dd className="mono">
              {rupees(d.collected)} · {rupees(d.expenses)} · {rupees(d.fees)}
            </dd>
            <dt>Gross · WHT · net</dt>
            <dd className="mono">
              {rupees(d.gross)} · {rupees(d.wht)} · {rupees(d.net)}
            </dd>
            <dt>Holders · units</dt>
            <dd className="mono">
              {int(d.holders)} · {units(d.units)}
            </dd>
            <dt>Merkle root (attached)</dt>
            <dd className="mono small" data-testid="calculation-root">
              {d.root ?? "not attached yet"}
            </dd>
            <dt>Statement · tax schedule hash</dt>
            <dd className="mono small">
              {d.statementHash ?? "–"} · {d.taxScheduleHash ?? "–"}
            </dd>
            <dt>Calculated · attached by</dt>
            <dd className="mono">
              {d.calculatedBy} · {d.attachedBy ?? "–"}
            </dd>
            <dt>Digest</dt>
            <dd className="mono small">{d.digest}</dd>
          </dl>
        </section>
        <section className="card" aria-labelledby="dec">
          <h2 id="dec">Trustee pre-check</h2>
          {d.trustee ? (
            <p className={d.trustee.decision === "approve" ? "alert ok" : "alert bad"} data-testid="trustee-decision">
              {d.trustee.decision === "approve" ? "Pre-checked" : "Rejected"} by {d.trustee.by} · {pkt(d.trustee.at)} · {d.trustee.reason}
            </p>
          ) : null}
          <DecisionPanel
            csrf={officer.csrf}
            action={`/api/trustee/cosign/calculation/${String(d.id)}/decide`}
            hidden={{ digest: d.digest }}
            blockers={d.blockers}
            extra={
              <>
                <label className="small mu" htmlFor="recomputed-root">
                  Merkle root you recomputed (needed to approve; must equal the attached root)
                </label>
                <input id="recomputed-root" name="root" pattern="0x[0-9a-fA-F]{64}" placeholder="0x…" className="mono" />
              </>
            }
            note="The operations checker approves only after this pre-check; recorded in the trustee and admin audit chains."
          />
        </section>
      </div>
      <section className="card" aria-labelledby="lines">
        <h2 id="lines">Entitlement lines (net paisa is the Merkle leaf)</h2>
        <div className="tbl-wrap">
          <table className="t" data-testid="calculation-lines">
            <thead>
              <tr>
                <th scope="col">Wallet</th>
                <th scope="col" className="n">
                  Units
                </th>
                <th scope="col" className="n">
                  Gross
                </th>
                <th scope="col" className="n">
                  WHT
                </th>
                <th scope="col" className="n">
                  Net
                </th>
              </tr>
            </thead>
            <tbody>
              {d.lines.map((l) => (
                <tr key={l.wallet}>
                  <td className="mono small">{l.wallet}</td>
                  <td className="n mono">{units(l.units)}</td>
                  <td className="n mono">{rupees(l.gross)}</td>
                  <td className="n mono">{rupees(l.wht)}</td>
                  <td className="n mono">{rupees(l.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </Shell>
  );
}
