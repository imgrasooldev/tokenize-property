import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActionPanel } from "@/components/ActionPanel";
import { DecisionPanel, Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { pkt } from "@/lib/format";
import { stateChip } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";
import { codeLabel, units } from "@/lib/server/trustee";
import { dutyLabel, offeringVoteRequest, propertyName, rupees } from "@/lib/server/votes";

export const metadata: Metadata = { title: "Offering request" };

/**
 * One S-02 request as a platform officer votes on it (migration 0026): the terms (price, units,
 * dates, use of proceeds, document hashes), the property, the votes so far and the duties still
 * missing. The vote runs offering.decide under the officer's handle, bound to the request digest.
 * An offering pending approval whose request lapsed is returned to draft here (L2).
 */
export default async function OfferingVotePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const valid = /^[1-9]\d{0,17}$/.test(id);
  const officer = await requirePage("offering.read", `/approvals/offering/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const r = await offeringVoteRequest(officer.sessionHash, id);
  if (!r) notFound();
  const o = r.offering;

  return (
    <Shell officer={officer} current="/approvals/offering" title={`Offering request #${String(r.id)}`}>
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="req">
          <h2 id="req">
            <span data-testid="offering-title">{codeLabel(r.code)}</span> <span className="sp" />
            <span className={stateChip(r.expired ? "expired" : r.status)} data-testid="offering-status">
              {r.expired ? "expired" : r.status}
            </span>
          </h2>
          <p className="small mu">{r.note}</p>
          <dl className="kv">
            <dt>Property</dt>
            <dd>{propertyName(r.property)}</dd>
            <dt>Needs</dt>
            <dd>{r.needs.map(dutyLabel).join(" + ")}</dd>
            <dt>Still needed</dt>
            <dd data-testid="offering-missing">{r.missing.length ? r.missing.map(dutyLabel).join(", ") : "no platform vote (trustee only, or decided)"}</dd>
            <dt>Requested by</dt>
            <dd className="mono">
              {r.requestedBy} · {pkt(r.requestedAt)}
            </dd>
            <dt>Reason</dt>
            <dd>{r.reason}</dd>
            <dt>Expires</dt>
            <dd>{pkt(r.expiresAt)}</dd>
            <dt>Digest</dt>
            <dd className="mono small">{r.digest}</dd>
          </dl>
          {r.problem ? <p className="alert bad">{r.problem}</p> : null}
        </section>
        <section className="card" aria-labelledby="terms">
          <h2 id="terms">
            Terms <span className="sp" />
            <span className={stateChip(o.state)}>{o.state}</span>
          </h2>
          <dl className="kv" data-testid="offering-terms">
            <dt>Price per unit</dt>
            <dd className="mono">{rupees(o.pricePaisa)}</dd>
            <dt>Min raise · target · hard cap</dt>
            <dd className="mono">
              {units(o.minRaiseUnits)} · {units(o.targetUnits)} · {units(o.hardCapUnits)} units
            </dd>
            <dt>Per investor</dt>
            <dd className="mono">
              {units(o.minUnits)} to {units(o.maxUnits)} units (register {units(o.registerUnits)}, max holding {units(o.maxHoldingUnits)})
            </dd>
            <dt>Window</dt>
            <dd>
              {pkt(o.opensAt)} → {pkt(o.closesAt)}
            </dd>
            <dt>Categories</dt>
            <dd>{o.categories.join(", ")}</dd>
            <dt>Offering document EN</dt>
            <dd className="mono small">{o.docEnSha256 ?? "–"}</dd>
            <dt>Offering document UR</dt>
            <dd className="mono small">{o.docUrSha256 ?? "–"}</dd>
            <dt>Risk disclosure</dt>
            <dd className="mono small">{o.riskSha256 ?? "–"}</dd>
            <dt>Maker</dt>
            <dd className="mono">{o.createdBy}</dd>
          </dl>
          {o.useOfProceeds && o.useOfProceeds.length > 0 ? (
            <>
              <b className="small">Use of proceeds</b>
              <ul className="small">
                {o.useOfProceeds.map((u) => (
                  <li key={u.line}>
                    {u.line}: {rupees(u.paisa)}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      </div>

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
                    {v.approve ? "✓" : "✕"} {v.officer} <span className="chip">{dutyLabel(v.duty)}</span>
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
          <h2 id="dec">Your vote</h2>
          <DecisionPanel
            csrf={officer.csrf}
            action={`/api/approvals/offering/${String(r.id)}/decide`}
            hidden={{ digest: r.digest }}
            blockers={r.blockers}
            approveBlockers={r.approveBlockers}
            note="One rejection is final. Recorded in the offering and admin audit chains."
          />
          {r.code === "L3" ? (
            <>
              <h3 className="small">Return to draft (L2)</h3>
              <ActionPanel
                csrf={officer.csrf}
                action={`/api/approvals/offering/${String(r.id)}/return`}
                hidden={{ digest: r.digest }}
                actions={[{ action: "return", label: "Return to draft with security key", blockers: r.returnBlockers }]}
                note="Open requests become stale; the maker resubmits."
              />
            </>
          ) : null}
        </section>
      </div>
    </Shell>
  );
}
