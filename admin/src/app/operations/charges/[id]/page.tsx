import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DecisionPanel, Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { pkt } from "@/lib/format";
import { stateChip } from "@/lib/server/compliance";
import { charge, rupees } from "@/lib/server/operations";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Charge" };

/**
 * One expense, fee or reserve movement (S-03 OT-2): what it is, the SHA-256 of its evidence, who
 * proposed it, and the checker's decision (a different officer, step-up, bound to this digest).
 */
export default async function ChargePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const valid = /^[1-9]\d{0,17}$/.test(id);
  const officer = await requirePage("operations.read", `/operations/charges/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const c = await charge(officer.sessionHash, id);
  if (!c) notFound();

  return (
    <Shell officer={officer} current="/operations" title={`Charge #${String(c.id)}`}>
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="chg">
          <h2 id="chg">
            {c.kind === "fee" ? `Fee (${c.feeType ?? ""})` : c.kind.replace("_", " ")} <span className="sp" />
            <span className={stateChip(c.status)} data-testid="charge-status">
              {c.status}
            </span>
          </h2>
          <dl className="kv">
            <dt>Period</dt>
            <dd>
              <a href={`/operations?token=${c.token}&period=${c.period}`}>{c.period}</a> <span className="mono small mu">{c.token}</span>
            </dd>
            <dt>Amount</dt>
            <dd className="mono" data-testid="charge-amount">
              {rupees(c.amount)}
              {c.aboveLimit ? <span className="dn"> · above the operations limit of {rupees(c.limit)}</span> : null}
            </dd>
            <dt>Payee</dt>
            <dd className="mono">{c.payee ?? "–"}</dd>
            <dt>Description</dt>
            <dd>{c.description}</dd>
            <dt>Evidence SHA-256</dt>
            <dd className="mono small">{c.evidence}</dd>
            <dt>Proposed by (maker)</dt>
            <dd className="mono">
              {c.proposedBy} · {pkt(c.proposedAt)}
            </dd>
            <dt>Decided</dt>
            <dd>{c.decidedBy ? `${c.decidedBy} · ${pkt(c.decidedAt)} · ${c.decisionReason ?? ""}` : "–"}</dd>
            <dt>Ledger journal</dt>
            <dd className="mono">{c.journal ?? "–"}</dd>
          </dl>
        </section>
        <section className="card" aria-labelledby="dec">
          <h2 id="dec">Your decision</h2>
          <DecisionPanel
            csrf={officer.csrf}
            action={`/api/operations/charges/${String(c.id)}/decide`}
            hidden={{ digest: c.digest }}
            blockers={c.blockers.reject}
            approveBlockers={c.blockers.approve.filter((b) => !c.blockers.reject.includes(b))}
            note="Approval posts the ledger journal; recorded in the operations and admin audit chains."
          />
        </section>
      </div>
    </Shell>
  );
}
