import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ComplianceTabs } from "@/components/ComplianceTabs";
import { DecisionPanel, Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { pkt } from "@/lib/format";
import { partialFreezeRequest, stateChip } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Partial freeze request" };

/**
 * One partial freeze or release (migration 0054): the amount and the token, the wallet's free units
 * now, who proposed it and why, the investor (masked; the KYC status does not change), whether it is
 * on chain, the outbox command, and the decision (a different compliance officer, step-up, digest).
 */
export default async function PartialFreezePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const valid = /^[1-9]\d{0,17}$/.test(id);
  const officer = await requirePage("compliance.read", `/compliance/partial-freezes/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const r = await partialFreezeRequest(officer.sessionHash, id);
  if (!r) notFound();
  const units = (n: string) => Number(n).toLocaleString("en-PK");

  return (
    <Shell officer={officer} current="/compliance/freezes" title={`Partial ${r.kind === "freeze" ? "freeze" : "release"} #${String(r.id)}`}>
      <ComplianceTabs current="/compliance/freezes" />
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="req">
          <h2 id="req">
            {r.kind === "freeze" ? `Freeze ${units(r.amount)} units` : `Release ${units(r.amount)} units`} <span className="sp" />
            <span className={stateChip(r.status)} data-testid="partial-status">
              {r.status}
            </span>
          </h2>
          <dl className="kv">
            <dt>Wallet</dt>
            <dd className="mono small">{r.wallet}</dd>
            <dt>Token</dt>
            <dd className="mono small">{r.token}</dd>
            <dt>Amount</dt>
            <dd data-testid="partial-amount">{units(r.amount)} units</dd>
            {r.kind === "freeze" ? (
              <>
                <dt>Free units now</dt>
                <dd>{units(r.freeUnits)} (balance minus frozen and approved partial freezes, read model)</dd>
              </>
            ) : null}
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
                <dt>Releases</dt>
                <dd>
                  <a href={`/compliance/partial-freezes/${String(r.lifts)}`}>partial freeze #{r.lifts}</a>
                </dd>
              </>
            ) : null}
            {r.released ? (
              <>
                <dt>Released by</dt>
                <dd>
                  <a href={`/compliance/partial-freezes/${String(r.released)}`}>release #{r.released}</a>
                </dd>
              </>
            ) : null}
            <dt>Linked cases</dt>
            <dd>
              {r.kycCase ? <a href={`/compliance/kyc/${String(r.kycCase)}`}>KYC #{r.kycCase}</a> : null} {r.strCase ? <a href={`/compliance/str/${String(r.strCase)}`}>STR #{r.strCase}</a> : null}
              {!r.kycCase && !r.strCase ? "–" : null}
            </dd>
            <dt>caseId on chain</dt>
            <dd className="mono small">
              {r.caseId} · {r.onChain ? "on chain" : "not on chain yet"}
            </dd>
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
              <span className={stateChip(r.subject.status)}>{r.subject.status}</span> <span className="mu small">(a partial freeze does not change it)</span>
            </dd>
          </dl>
          <h2 style={{ marginBlockStart: 12 }}>Your decision</h2>
          <DecisionPanel
            csrf={officer.csrf}
            action={`/api/compliance/partial-freezes/${String(r.id)}/decide`}
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
