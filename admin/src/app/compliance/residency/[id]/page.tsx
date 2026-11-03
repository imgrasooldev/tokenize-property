import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActionPanel, type PanelAction } from "@/components/ActionPanel";
import { ComplianceTabs } from "@/components/ComplianceTabs";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { pkt } from "@/lib/format";
import { actionLabel, countryName, RESIDENCY_ACTIONS, residencyReview, stateChip } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Residency review" };

const TONES = new Map<string, PanelAction["tone"]>([
  ["confirm", "ok"],
  ["reject", "no"],
]);

/**
 * One residency review (spec S-08 RD-2): the document (NICOP or POC), the country of residence, the
 * investor (masked) and the payout account kind; one officer proposes approval, a different one
 * confirms or declines it; rejecting revokes the verification. Step-up and digest on every action.
 */
export default async function ResidencyReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const valid = /^[1-9]\d{0,17}$/.test(id);
  const officer = await requirePage("compliance.read", `/compliance/residency/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const v = await residencyReview(officer.sessionHash, id);
  if (!v) notFound();
  const actions: PanelAction[] = RESIDENCY_ACTIONS.map((a) => ({ action: a, label: actionLabel(a), blockers: new Map(Object.entries(v.blockers)).get(a) ?? [], tone: TONES.get(a) ?? "plain" }));

  return (
    <Shell officer={officer} current="/compliance/freezes" title={`Residency review #${String(v.id)}`}>
      <ComplianceTabs current="/compliance/residency" />
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="rev">
          <h2 id="rev">
            Investor living abroad <span className="sp" />
            <span className={stateChip(v.status)} data-testid="residency-status">
              {v.status}
            </span>
          </h2>
          <dl className="kv">
            <dt>Document</dt>
            <dd>{v.document.toUpperCase()}</dd>
            <dt>Lives in</dt>
            <dd data-testid="residency-country">{countryName(v.country)}</dd>
            <dt>Recorded</dt>
            <dd>{pkt(v.recordedAt)}</dd>
            <dt>Proposed by</dt>
            <dd>{v.proposedBy ? `${v.proposedBy} · ${v.proposalReason ?? ""}` : "–"}</dd>
            <dt>Decided</dt>
            <dd>{v.decidedBy ? `${v.decidedBy} · ${pkt(v.decidedAt)} · ${v.decisionReason ?? ""}` : "–"}</dd>
            <dt>Payout account</dt>
            <dd>{v.payoutKind ? (v.payoutKind === "rda" ? "Roshan Digital Account" : "domestic (not used while the investor lives abroad)") : "none yet"}</dd>
          </dl>
        </section>
        <section className="card" aria-labelledby="act">
          <h2 id="inv">Investor</h2>
          <dl className="kv">
            <dt>Reference</dt>
            <dd className="mono">{v.subject.ref}</dd>
            <dt>Identity number</dt>
            <dd className="mono">{v.subject.cnic}</dd>
            <dt>KYC status</dt>
            <dd>
              <span className={stateChip(v.subject.status)}>{v.subject.status}</span> <span className="mu small">(own status {v.subject.underlyingStatus})</span>
            </dd>
          </dl>
          <h2 id="act" style={{ marginBlockStart: 12 }}>
            Your decision
          </h2>
          <ActionPanel
            csrf={officer.csrf}
            action={`/api/compliance/residency/${String(v.id)}/act`}
            hidden={{ digest: v.digest }}
            actions={actions}
            note="Approval needs two compliance officers; rejecting revokes the verification."
          />
        </section>
      </div>
    </Shell>
  );
}
