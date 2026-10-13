import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DecisionPanel, Flash, GateChip } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { pkt } from "@/lib/format";
import { unfreezeRequest } from "@/lib/server/approvals";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Unfreeze request" };

/**
 * One reconciliation unfreeze request (ADR 0007 R-3): the freeze it lifts, the run that froze
 * payouts, the latest run, and whether a run passed after the freeze (the backend's condition).
 */
export default async function UnfreezePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const valid = /^[1-9]\d{0,17}$/.test(id);
  const officer = await requirePage("approvals.read", `/approvals/unfreeze/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const u = await unfreezeRequest(officer.sessionHash, id);
  if (!u) notFound();

  return (
    <Shell officer={officer} current="/approvals" title="Unfreeze request" actions={<GateChip gate={u.gate} />}>
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="req">
          <h2 id="req">
            Unfreeze payouts · request #{u.id} <span className="sp" />
            <span className={u.status === "open" ? "chip warn" : u.status === "approved" ? "chip ok" : "chip bad"} data-testid="unfreeze-status">
              {u.status}
            </span>
          </h2>
          <dl className="kv">
            <dt>Requested by (maker)</dt>
            <dd className="mono">{u.requestedBy}</dd>
            <dt>Reason</dt>
            <dd>{u.reason}</dd>
            <dt>Requested</dt>
            <dd>{pkt(u.requestedAt)}</dd>
            <dt>Expires</dt>
            <dd>{pkt(u.expiresAt)}</dd>
            <dt>Decided</dt>
            <dd>{u.decidedBy ? `${u.decidedBy} · ${pkt(u.decidedAt)} · ${u.decisionReason ?? ""}` : "–"}</dd>
          </dl>
          <h2 style={{ marginBlockStart: 12 }}>The freeze it lifts</h2>
          <dl className="kv">
            <dt>Freeze event</dt>
            <dd className="mono">
              #{u.freeze.event} · {pkt(u.freeze.at)}
            </dd>
            <dt>Froze by</dt>
            <dd className="mono">
              run {u.freeze.run} ({u.freezingRun ? `${u.freezingRun.status}, ${String(u.freezingRun.blocking ?? 0)} blocking` : "?"})
            </dd>
            <dt>Why</dt>
            <dd>{u.freeze.reason}</dd>
            <dt>Latest finished run</dt>
            <dd className="mono" data-testid="latest-run">
              {u.latestRun ? `run ${String(u.latestRun.id)}: ${u.latestRun.status} at ${pkt(u.latestRun.finishedAt)}` : "none"}
            </dd>
          </dl>
        </section>
        <section className="card" aria-labelledby="dec">
          <h2 id="dec">Your decision</h2>
          <p className="small mu" style={{ marginBlockEnd: 8 }}>
            Approving reopens payouts only if a reconciliation run passed after the run that froze them; the gate also needs that run to be less
            than 26 hours old.
          </p>
          <DecisionPanel
            csrf={officer.csrf}
            action={`/api/approvals/unfreeze/${String(u.id)}/decide`}
            hidden={{ freezeEvent: String(u.freeze.event) }}
            blockers={u.blockers}
            approveBlockers={u.approveBlockers}
            note="Recorded in the reconciliation and admin audit chains."
          />
        </section>
      </div>
    </Shell>
  );
}
