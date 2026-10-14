import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DecisionPanel, Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { TrusteeTabs } from "@/components/TrusteeTabs";
import { int, pkt, short } from "@/lib/format";
import { stateChip } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";
import { codeLabel, offeringRequest, units } from "@/lib/server/trustee";

export const metadata: Metadata = { title: "Offering request" };

/**
 * An S-02 request that needs the trustee duty (Step 6d): what it changes, the issuance batch lines
 * or the completion record it carries, the votes so far and why the trustee may not vote now. The
 * vote runs offering.decide under the officer's handle, bound to the request's digest.
 */
export default async function OfferingRequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const valid = /^[1-9]\d{0,17}$/.test(id);
  const officer = await requirePage("trustee.read", `/trustee/cosign/offering/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const r = await offeringRequest(officer.sessionHash, id);
  if (!r) notFound();
  const detail = Object.entries(r.detail).filter(([k]) => k !== "conditions");
  const conditions = r.detail.conditions && typeof r.detail.conditions === "object" ? Object.entries(r.detail.conditions as Record<string, unknown>) : [];

  return (
    <Shell officer={officer} current="/trustee/cosign" title={`Offering request #${String(r.id)}`}>
      <TrusteeTabs current="/trustee/cosign" />
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="req">
          <h2 id="req">
            <span data-testid="offering-title">{codeLabel(r.code)}</span> <span className="sp" />
            <span className={stateChip(r.status === "open" ? "open" : r.status)} data-testid="offering-status">
              {r.status}
            </span>
          </h2>
          <p className="small mu">{r.note}</p>
          <dl className="kv">
            <dt>Code</dt>
            <dd className="mono">{r.code}</dd>
            <dt>Needs</dt>
            <dd className="mono">{r.needs.join(" + ")}</dd>
            <dt>Requested by</dt>
            <dd className="mono">
              {r.requestedBy} · {pkt(r.requestedAt)}
            </dd>
            <dt>Reason</dt>
            <dd>{r.reason}</dd>
            <dt>Expires</dt>
            <dd>{pkt(r.expiresAt)}</dd>
            {detail.map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <dt className="mono">{k}</dt>
                <dd className="mono small">{typeof v === "string" ? v : JSON.stringify(v)}</dd>
              </div>
            ))}
            <dt>Digest</dt>
            <dd className="mono small">{r.digest}</dd>
          </dl>
          {conditions.length > 0 ? (
            <>
              <b className="small">Conditions precedent (SHA-256 of the evidence)</b>
              <dl className="kv">
                {conditions.map(([k, v]) => (
                  <div key={k} style={{ display: "contents" }}>
                    <dt className="mono">{k}</dt>
                    <dd className="mono small">{String(v)}</dd>
                  </div>
                ))}
              </dl>
            </>
          ) : null}
        </section>
        <section className="card" aria-labelledby="off">
          <h2 id="off">Offering</h2>
          <dl className="kv">
            <dt>Offering</dt>
            <dd className="mono small">{r.offering.id}</dd>
            <dt>State now</dt>
            <dd>
              <span className={stateChip(r.offering.state)}>{r.offering.state}</span> <span className="mu small">(request made in {r.offeringState})</span>
            </dd>
            <dt>Token</dt>
            <dd className="mono small">{r.offering.token ?? "–"}</dd>
            <dt>Price per unit</dt>
            <dd className="mono">{r.offering.priceRupees ? `Rs ${r.offering.priceRupees}` : "–"}</dd>
            <dt>Min raise · target · hard cap</dt>
            <dd className="mono">
              {units(r.offering.minRaiseUnits)} · {units(r.offering.targetUnits)} · {units(r.offering.hardCapUnits)}
            </dd>
            <dt>Supply · trustee cap (chain)</dt>
            <dd className="mono">
              {units(r.offering.supply)} · {units(r.offering.trusteeCap)}
            </dd>
          </dl>
          {r.problem ? <p className="alert bad">{r.problem}</p> : null}
        </section>
      </div>

      {r.batch ? (
        <section className="card" aria-labelledby="batch">
          <h2 id="batch">
            Issuance batch #{r.batch.id} <span className="sp" />
            <span className={r.batch.matchesAllocations ? "chip ok" : "chip bad"} data-testid="batch-matches">
              {r.batch.matchesAllocations ? "matches the allocations" : "no longer matches the allocations"}
            </span>
          </h2>
          <p className="small mu">
            {int(r.batch.items)} lines · {units(String(r.batch.totalUnits))} units · prepared by <span className="mono">{r.batch.preparedBy}</span> · digest{" "}
            <span className="mono">{short(r.batch.digest, 8)}</span>
          </p>
          <div className="tbl-wrap">
            <table className="t" data-testid="batch-lines">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">refId</th>
                  <th scope="col">Wallet</th>
                  <th scope="col" className="n">
                    Units
                  </th>
                </tr>
              </thead>
              <tbody>
                {r.batch.lines.map((l) => (
                  <tr key={l.line}>
                    <td className="mono">{l.line}</td>
                    <td className="mono small">{short(l.refId, 8)}</td>
                    <td className="mono small">{l.wallet}</td>
                    <td className="n mono">{units(String(l.units))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <div className="g2">
        <section className="card" aria-labelledby="votes">
          <h2 id="votes">Votes</h2>
          {r.votes.length === 0 ? (
            <p className="empty">No vote yet.</p>
          ) : (
            <div className="sig">
              {r.votes.map((v) => (
                <div key={v.officer} className={v.approve ? "y" : "n"}>
                  <b className={v.approve ? "up" : "dn"}>
                    {v.approve ? "✓" : "✕"} {v.officer} <span className="chip">{v.duty}</span>
                  </b>
                  <div className="di small">
                    {pkt(v.at)} · {v.reason}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="card" aria-labelledby="dec">
          <h2 id="dec">Trustee vote</h2>
          <DecisionPanel
            csrf={officer.csrf}
            action={`/api/trustee/cosign/offering/${String(r.id)}/decide`}
            hidden={{ digest: r.digest }}
            blockers={r.blockers}
            approveBlockers={r.approveBlockers}
            note="One rejection is final. Recorded in the offering, trustee and admin audit chains."
          />
        </section>
      </div>
    </Shell>
  );
}
