import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DecisionPanel, Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { TrusteeTabs } from "@/components/TrusteeTabs";
import { pkt } from "@/lib/format";
import { rupees } from "@/lib/server/approvals";
import { stateChip } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";
import { trusteeCharge } from "@/lib/server/trustee";

export const metadata: Metadata = { title: "Charge above the limit" };

/**
 * An expense or fee above the operations limit (S-03 OP-21, E1, migration 0023 T-8): the trustee
 * approves or rejects it before the operations checker may approve it. Bound to the charge digest.
 */
export default async function TrusteeChargePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const valid = /^[1-9]\d{0,17}$/.test(id);
  const officer = await requirePage("trustee.read", `/trustee/cosign/charge/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const c = await trusteeCharge(officer.sessionHash, id);
  if (!c) notFound();

  return (
    <Shell officer={officer} current="/trustee/cosign" title={`Charge #${String(c.id)}`}>
      <TrusteeTabs current="/trustee/cosign" />
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="ch">
          <h2 id="ch">
            {c.kind === "fee" ? `Fee (${c.feeType ?? "?"})` : "Expense"} <span className="sp" />
            <span className={stateChip(c.status === "proposed" ? "open" : c.status)} data-testid="charge-status">
              {c.status}
            </span>
          </h2>
          <dl className="kv">
            <dt>Token · period</dt>
            <dd className="mono small">
              {c.token} · {c.period}
            </dd>
            <dt>Payee</dt>
            <dd className="mono">{c.payee ?? "–"}</dd>
            <dt>Description</dt>
            <dd>{c.description}</dd>
            <dt>Amount</dt>
            <dd className="mono" data-testid="charge-amount">
              {rupees(c.amount)}
            </dd>
            <dt>Operations limit</dt>
            <dd className="mono">{rupees(c.limit)}</dd>
            <dt>Evidence SHA-256</dt>
            <dd className="mono small">{c.evidence}</dd>
            <dt>Proposed by</dt>
            <dd className="mono">
              {c.proposedBy} · {pkt(c.proposedAt)}
            </dd>
            <dt>Operations decision</dt>
            <dd>{c.decidedBy ? `${c.decidedBy} · ${pkt(c.decidedAt)}` : "waiting"}</dd>
            <dt>Digest</dt>
            <dd className="mono small">{c.digest}</dd>
          </dl>
        </section>
        <section className="card" aria-labelledby="dec">
          <h2 id="dec">Trustee decision</h2>
          {c.trustee ? (
            <p className={c.trustee.decision === "approve" ? "alert ok" : "alert bad"} data-testid="trustee-decision">
              {c.trustee.decision === "approve" ? "Approved" : "Rejected"} by {c.trustee.by} · {pkt(c.trustee.at)} · {c.trustee.reason}
            </p>
          ) : null}
          <DecisionPanel
            csrf={officer.csrf}
            action={`/api/trustee/cosign/charge/${String(c.id)}/decide`}
            hidden={{ digest: c.digest }}
            blockers={c.blockers}
            note="The operations checker approves only after the trustee; recorded in the trustee and admin audit chains."
          />
        </section>
      </div>
    </Shell>
  );
}
