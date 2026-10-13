import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ComplianceTabs } from "@/components/ComplianceTabs";
import { DecisionPanel, Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { pkt } from "@/lib/format";
import { freezeRequest, stateChip } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Freeze request" };

/**
 * One freeze or unfreeze request: who proposed it and why (reason code + text), the investor
 * (masked), the hold it places or lifts, the outbox command and its execution, and the decision
 * (a different compliance officer, step-up, bound to the request's digest).
 */
export default async function FreezeRequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const valid = /^[1-9]\d{0,17}$/.test(id);
  const officer = await requirePage("compliance.read", `/compliance/freezes/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const r = await freezeRequest(officer.sessionHash, id);
  if (!r) notFound();

  return (
    <Shell officer={officer} current="/compliance/freezes" title={`${r.kind === "freeze" ? "Freeze" : "Unfreeze"} request #${String(r.id)}`}>
      <ComplianceTabs current="/compliance/freezes" />
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="req">
          <h2 id="req">
            {r.kind === "freeze" ? "Freeze the wallet" : "Unfreeze the wallet"} <span className="sp" />
            <span className={stateChip(r.status)} data-testid="freeze-status">
              {r.status}
            </span>
          </h2>
          <dl className="kv">
            <dt>Wallet</dt>
            <dd className="mono small">{r.wallet}</dd>
            <dt>Reason code</dt>
            <dd>
              <span className="mono">{r.reasonCode}</span> · {r.reasonLabel ?? ""}
            </dd>
            <dt>Reason</dt>
            <dd>{r.reason}</dd>
            <dt>Proposed by (maker)</dt>
            <dd className="mono">
              {r.requestedBy} · {pkt(r.requestedAt)}
            </dd>
            <dt>Expires</dt>
            <dd>{pkt(r.expiresAt)}</dd>
            {r.lifts ? (
              <>
                <dt>Lifts</dt>
                <dd>
                  <a href={`/compliance/freezes/${String(r.lifts)}`}>freeze #{r.lifts}</a>
                </dd>
              </>
            ) : null}
            <dt>Linked cases</dt>
            <dd>
              {r.kycCase ? <a href={`/compliance/kyc/${String(r.kycCase)}`}>KYC #{r.kycCase}</a> : null} {r.strCase ? <a href={`/compliance/str/${String(r.strCase)}`}>STR #{r.strCase}</a> : null}
              {!r.kycCase && !r.strCase ? "–" : null}
            </dd>
            <dt>caseId on chain</dt>
            <dd className="mono small">{r.caseId}</dd>
            <dt>Decided</dt>
            <dd>{r.decidedBy ? `${r.decidedBy} · ${pkt(r.decidedAt)} · ${r.decisionReason ?? ""}` : "–"}</dd>
            <dt>Outbox command</dt>
            <dd className="mono small" data-testid="command">
              {r.command ? `${r.command.kind} · ${r.command.status} · attempts ${String(r.command.attempts)}${r.command.txHash ? ` · ${r.command.txHash}` : ""}` : "–"}
              {r.command?.lastError ? <span className="dn"> · {r.command.lastError}</span> : null}
            </dd>
          </dl>
        </section>
        <section className="card" aria-labelledby="inv">
          <h2 id="inv">Investor</h2>
          <dl className="kv">
            <dt>Reference</dt>
            <dd className="mono">{r.subject.ref}</dd>
            <dt>CNIC</dt>
            <dd className="mono">{r.subject.cnic}</dd>
            <dt>KYC status</dt>
            <dd>
              <span className={stateChip(r.subject.status)}>{r.subject.status}</span> <span className="mu small">(own status {r.subject.underlyingStatus})</span>
            </dd>
          </dl>
          <h2 style={{ marginBlockStart: 12 }}>Your decision</h2>
          <DecisionPanel
            csrf={officer.csrf}
            action={`/api/compliance/freezes/${String(r.id)}/decide`}
            hidden={{ digest: r.digest }}
            blockers={r.blockers}
            approveBlockers={r.approveBlockers}
            note="Approval queues the command for the signing service; recorded in the compliance and admin audit chains."
          />
        </section>
      </div>
    </Shell>
  );
}
