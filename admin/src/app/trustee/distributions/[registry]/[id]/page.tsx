import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DecisionPanel, Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { TrusteeTabs } from "@/components/TrusteeTabs";
import { pkt } from "@/lib/format";
import { rupees } from "@/lib/server/approvals";
import { stateChip } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";
import { ADDRESS, distribution } from "@/lib/server/trustee";

export const metadata: Metadata = { title: "Distribution review" };

/**
 * One published rent distribution and the trustee's review in the 48-hour challenge window (S-03
 * D4/D6). Approval needs the Merkle root the trustee recomputed independently (from the record
 * block and the statement); it must equal the published root. A rejection is recorded here and
 * blocks booking and payout in the database at once; the on-chain reject(id, reason) is then
 * executed from the Trustee Safe (never from this portal).
 */
export default async function DistributionPage({
  params,
  searchParams,
}: {
  params: Promise<{ registry: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { registry, id } = await params;
  const valid = ADDRESS.test(registry) && /^[1-9]\d{0,30}$/.test(id);
  const officer = await requirePage("trustee.read", `/trustee/distributions/${valid ? `${registry}/${id}` : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const d = await distribution(officer.sessionHash, registry, id);
  if (!d) notFound();

  return (
    <Shell officer={officer} current="/trustee/distributions" title={`Distribution #${d.id}`}>
      <TrusteeTabs current="/trustee/distributions" />
      <Flash q={q} />
      {d.blocked ? (
        <p className="alert bad" role="note" data-testid="distribution-blocked">
          Finalisation blocked in the database: {d.blocked}
          {d.status === "published" ? " Execute reject(id, reason) from the Trustee Safe before the window closes." : ""}
        </p>
      ) : null}
      <div className="g2">
        <section className="card" aria-labelledby="dist">
          <h2 id="dist">
            Rent distribution <span className="sp" />
            <span className={stateChip(d.status === "published" ? "open" : d.status === "paid" ? "done" : d.status)} data-testid="distribution-status">
              {d.status}
            </span>
          </h2>
          <dl className="kv">
            <dt>Registry · id</dt>
            <dd className="mono small">
              {d.registry} · {d.id}
            </dd>
            <dt>Token</dt>
            <dd className="mono small">{d.token}</dd>
            <dt>Record block</dt>
            <dd className="mono">#{d.recordBlock}</dd>
            <dt>Total</dt>
            <dd className="mono">{rupees(d.totalPaisa)}</dd>
            <dt>Merkle root (published)</dt>
            <dd className="mono small" data-testid="merkle-root">
              {d.merkleRoot}
            </dd>
            <dt>Statement hash</dt>
            <dd className="mono small">{d.statementHash}</dd>
            <dt>Published</dt>
            <dd>
              block #{d.publishedBlock} · {pkt(d.publishedAt)}
            </dd>
            <dt>Challenge window closes</dt>
            <dd data-testid="window-closes">{pkt(d.windowCloses)}</dd>
            {d.rejectReason ? (
              <>
                <dt>Rejected on chain</dt>
                <dd>{d.rejectReason}</dd>
              </>
            ) : null}
            <dt>Booked in the ledger</dt>
            <dd>{d.ledgerBooked ? "yes" : "no"}</dd>
            <dt>Payout batches</dt>
            <dd className="mono small">{d.payoutBatches.length ? d.payoutBatches.map((b) => `${b.reference} (${b.status})`).join(", ") : "none"}</dd>
            <dt>Read model block</dt>
            <dd className="mono">#{d.pinned?.block ?? "–"}</dd>
            <dt>Digest</dt>
            <dd className="mono small">{d.digest}</dd>
          </dl>
        </section>
        <section className="card" aria-labelledby="rev">
          <h2 id="rev">Trustee review</h2>
          {d.review ? (
            <dl className="kv" data-testid="distribution-review">
              <dt>Decision</dt>
              <dd>
                <span className={d.review.decision === "approve" ? "chip ok" : "chip bad"}>{d.review.decision === "approve" ? "approved" : "rejected"}</span>
              </dd>
              <dt>By</dt>
              <dd className="mono">
                {d.review.by} · {pkt(d.review.at)}
              </dd>
              <dt>Reason</dt>
              <dd>{d.review.reason}</dd>
              {d.review.recomputedRoot ? (
                <>
                  <dt>Recomputed root</dt>
                  <dd className="mono small">{d.review.recomputedRoot}</dd>
                </>
              ) : null}
            </dl>
          ) : null}
          <DecisionPanel
            csrf={officer.csrf}
            action={`/api/trustee/distributions/${d.registry}/${d.id}/decide`}
            hidden={{ digest: d.digest }}
            blockers={d.blockers}
            extra={
              <>
                <label className="small mu" htmlFor="recomputed-root">
                  Merkle root you recomputed (needed to approve; must equal the published root)
                </label>
                <input id="recomputed-root" name="root" pattern="0x[0-9a-fA-F]{64}" placeholder="0x…" className="mono" />
              </>
            }
            note="A rejection blocks booking and payout at once; recorded in the trustee and admin audit chains."
          />
        </section>
      </div>
    </Shell>
  );
}
