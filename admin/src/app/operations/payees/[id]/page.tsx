import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DecisionPanel, Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { pkt } from "@/lib/format";
import { stateChip } from "@/lib/server/compliance";
import { assistedPayee } from "@/lib/server/payees";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Assisted payout account" };

/**
 * One assisted payout-account change (migration 0055 AP-3): the new account (bank code and last four
 * digits only), the current one, who entered it and why, and the decision of a different operations
 * checker (step-up, digest). Approval registers it with the 72-hour cooling-off.
 */
export default async function AssistedPayeePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const valid = /^[1-9]\d{0,17}$/.test(id);
  const officer = await requirePage("operations.read", `/operations/payees/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  if (!officer.permissions.has("operations.request") && !officer.permissions.has("operations.decide")) notFound();
  const q = await searchParams;
  const p = await assistedPayee(officer.sessionHash, id);
  if (!p) notFound();

  return (
    <Shell officer={officer} current="/operations" title={`Assisted payout account #${String(p.id)}`}>
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="req">
          <h2 id="req">
            New payout account <span className="sp" />
            <span className={stateChip(p.status)} data-testid="payee-status">
              {p.status}
            </span>
          </h2>
          <dl className="kv">
            <dt>Account</dt>
            <dd className="mono" data-testid="payee-account">
              {p.bankCode} ····{p.last4}
            </dd>
            <dt>Current account</dt>
            <dd className="mono">{p.current ? `${p.current.bankCode} ····${p.current.last4} · since ${pkt(p.current.since)}` : "none"}</dd>
            <dt>Reason</dt>
            <dd>{p.reason}</dd>
            <dt>Entered by (maker)</dt>
            <dd className="mono">
              {p.requestedBy} · {pkt(p.requestedAt)}
            </dd>
            <dt>Expires</dt>
            <dd>{pkt(p.expiresAt)}</dd>
            <dt>Decided</dt>
            <dd>{p.decidedBy ? `${p.decidedBy} · ${pkt(p.decidedAt)} · ${p.decisionReason ?? ""}` : "–"}</dd>
            <dt>Registered</dt>
            <dd>{p.payee ? `payee #${String(p.payee.id)} · usable from ${pkt(p.payee.activeFrom)}` : "–"}</dd>
          </dl>
        </section>
        <section className="card" aria-labelledby="inv">
          <h2 id="inv">Investor</h2>
          <dl className="kv">
            <dt>Reference</dt>
            <dd className="mono">{p.subject.ref}</dd>
            <dt>CNIC</dt>
            <dd className="mono">{p.subject.cnic}</dd>
            <dt>KYC status</dt>
            <dd>
              <span className={stateChip(p.subject.status)}>{p.subject.status}</span>
            </dd>
          </dl>
          <h2 style={{ marginBlockStart: 12 }}>Your decision</h2>
          <DecisionPanel
            csrf={officer.csrf}
            action={`/api/operations/payees/${String(p.id)}/decide`}
            hidden={{ digest: p.digest }}
            blockers={p.blockers}
            approveBlockers={p.approveBlockers}
            note="Approve only after calling the investor back on the number on file. Recorded in the bank and admin audit chains."
          />
        </section>
      </div>
    </Shell>
  );
}
