import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DecisionPanel, Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { pkt } from "@/lib/format";
import { propertyRequest, transitionLabel } from "@/lib/server/approvals";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Property or KYB request" };

/**
 * One S-01 maker-checker request: the transition, the file's state and identifiers (sealed names
 * and addresses never leave the database), the evidence hashes, the duty the checker needs and the
 * request digest the decision is bound to. property.decide_request decides.
 */
export default async function PropertyRequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const valid = /^[1-9]\d{0,17}$/.test(id);
  const officer = await requirePage("property.read", `/approvals/property/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const p = await propertyRequest(officer.sessionHash, id);
  if (!p) notFound();

  return (
    <Shell officer={officer} current="/approvals/property" title="Property or KYB request">
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="req">
          <h2 id="req">
            {transitionLabel(p.code)} <span className="mono di small">{p.code}</span>
            <span className="sp" />
            <span className={p.status === "open" ? "chip warn" : p.status === "approved" ? "chip ok" : "chip bad"} data-testid="property-status">
              {p.status}
            </span>
          </h2>
          <dl className="kv">
            <dt>File</dt>
            <dd className="mono">
              {p.entity} {p.entityId}
            </dd>
            <dt>Transition</dt>
            <dd className="mono">
              {p.fromState} → {p.transition?.toState ?? "(screening cleared, state unchanged)"}
            </dd>
            <dt>Requested by (maker)</dt>
            <dd className="mono">{p.requestedBy}</dd>
            <dt>Reason</dt>
            <dd>{p.reason}</dd>
            {Object.entries(p.detail).map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <dt className="mono">{k}</dt>
                <dd className="mono small">{typeof v === "string" ? v : JSON.stringify(v)}</dd>
              </div>
            ))}
            <dt>Requested · expires</dt>
            <dd>
              {pkt(p.requestedAt)} · {pkt(p.expiresAt)}
            </dd>
            <dt>Decided</dt>
            <dd>{p.decidedBy ? `${p.decidedBy} · ${pkt(p.decidedAt)} · ${p.decisionReason ?? ""}` : "–"}</dd>
            <dt>Request digest</dt>
            <dd className="mono small" data-testid="request-digest">
              {p.digest}
            </dd>
          </dl>
          {p.sponsor ? (
            <>
              <h2 style={{ marginBlockStart: 12 }}>Sponsor (KYB)</h2>
              <dl className="kv">
                <dt>Kind · state</dt>
                <dd>
                  {p.sponsor.kind} · {p.sponsor.state}
                </dd>
                <dt>CUIN · NTN (last four)</dt>
                <dd className="mono">
                  {p.sponsor.cuinLast4 ?? "–"} · {p.sponsor.ntnLast4 ?? "–"}
                </dd>
                <dt>Risk rating</dt>
                <dd>{p.sponsor.risk ?? "–"}</dd>
                <dt>KYB valid until</dt>
                <dd>{pkt(p.sponsor.kybValidUntil)}</dd>
              </dl>
            </>
          ) : null}
          {p.property ? (
            <>
              <h2 style={{ marginBlockStart: 12 }}>Property</h2>
              <dl className="kv">
                <dt>State</dt>
                <dd>{p.property.state}</dd>
                <dt>Where</dt>
                <dd>
                  {p.property.district ?? "–"}, {p.property.province ?? "–"}
                </dd>
                <dt>Property key</dt>
                <dd className="mono small">{p.property.propertyKey ?? "–"}</dd>
                <dt>Use · submitted</dt>
                <dd>
                  {p.property.use ?? "–"} · {pkt(p.property.submittedAt)}
                </dd>
              </dl>
            </>
          ) : null}
        </section>
        <section className="card" aria-labelledby="dec">
          <h2 id="dec">Your decision</h2>
          <p className="small mu" style={{ marginBlockEnd: 8 }}>
            Needs an active <b>{p.checkerDuties.join(" or ")}</b> duty (spec S-01); whoever entered or submitted the file never decides it.
          </p>
          <DecisionPanel
            csrf={officer.csrf}
            action={`/api/approvals/property/${String(p.id)}/decide`}
            hidden={{ digest: p.digest }}
            blockers={p.blockers}
            note="Recorded in the property and admin audit chains."
          />
        </section>
      </div>
    </Shell>
  );
}
