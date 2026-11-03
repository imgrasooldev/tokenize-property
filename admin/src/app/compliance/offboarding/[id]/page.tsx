import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ComplianceTabs } from "@/components/ComplianceTabs";
import { DecisionPanel, Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { pkt } from "@/lib/format";
import { identityDeletion, stateChip } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Identity deletion" };

/**
 * One identity deletion (migration 0055 OB-2, OB-3): the wallet, the registry, units held now, the
 * request and the decision (a different compliance officer, step-up, digest). After approval the
 * page shows the exact timelock call for the Admin Safe; "done" once the identity is removed.
 */
export default async function IdentityDeletionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const valid = /^[1-9]\d{0,17}$/.test(id);
  const officer = await requirePage("compliance.read", `/compliance/offboarding/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const d = await identityDeletion(officer.sessionHash, id);
  if (!d) notFound();

  return (
    <Shell officer={officer} current="/compliance/freezes" title={`Identity deletion #${String(d.id)}`}>
      <ComplianceTabs current="/compliance/offboarding" />
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="req">
          <h2 id="req">
            Delete the identity of a wallet <span className="sp" />
            <span className={stateChip(d.status)} data-testid="deletion-status">
              {d.status}
            </span>
          </h2>
          <dl className="kv">
            <dt>Wallet</dt>
            <dd className="mono small">{d.wallet}</dd>
            <dt>Identity registry</dt>
            <dd className="mono small">{d.registry}</dd>
            <dt>Units held now</dt>
            <dd>{d.units}</dd>
            <dt>Reason</dt>
            <dd>{d.reason}</dd>
            <dt>Requested by (maker)</dt>
            <dd className="mono">
              {d.requestedBy} · {pkt(d.requestedAt)}
            </dd>
            <dt>Expires</dt>
            <dd>{pkt(d.expiresAt)}</dd>
            <dt>Decided</dt>
            <dd>{d.decidedBy ? `${d.decidedBy} · ${pkt(d.decidedAt)} · ${d.decisionReason ?? ""}` : "–"}</dd>
          </dl>
          {d.callData ? (
            <>
              <h2 style={{ marginBlockStart: 12 }}>Timelock call for the Admin Safe</h2>
              <p className="small mu">No platform key can delete an identity. The Admin Safe schedules this call on the timelock; the request reads done once the indexer sees it.</p>
              <dl className="kv" data-testid="timelock-call">
                <dt>Timelock</dt>
                <dd className="mono small">{d.timelock ?? "not in the read model"}</dd>
                <dt>Target</dt>
                <dd className="mono small">{d.registry}</dd>
                <dt>Value</dt>
                <dd className="mono small">0</dd>
                <dt>Data</dt>
                <dd className="mono small" style={{ overflowWrap: "anywhere" }}>
                  {d.callData}
                </dd>
                <dt>Predecessor</dt>
                <dd className="mono small">0x{"0".repeat(64)}</dd>
                <dt>Salt</dt>
                <dd className="mono small" style={{ overflowWrap: "anywhere" }}>
                  {d.caseRef}
                </dd>
              </dl>
            </>
          ) : null}
        </section>
        <section className="card" aria-labelledby="inv">
          <h2 id="inv">Investor</h2>
          <dl className="kv">
            <dt>Reference</dt>
            <dd className="mono">{d.subject.ref}</dd>
            <dt>CNIC</dt>
            <dd className="mono">{d.subject.cnic}</dd>
            <dt>KYC status</dt>
            <dd>
              <span className={stateChip(d.subject.status)}>{d.subject.status}</span>
            </dd>
          </dl>
          <h2 style={{ marginBlockStart: 12 }}>Your decision</h2>
          <DecisionPanel
            csrf={officer.csrf}
            action={`/api/compliance/offboarding/${String(d.id)}/decide`}
            hidden={{ digest: d.digest }}
            blockers={d.blockers}
            approveBlockers={d.approveBlockers}
            note="Zero units and a registered identity are checked again; recorded in the compliance and admin audit chains."
          />
        </section>
      </div>
    </Shell>
  );
}
