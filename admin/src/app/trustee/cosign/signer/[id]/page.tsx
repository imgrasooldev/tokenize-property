import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CallView } from "@/components/CallView";
import { DecisionPanel, Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { TrusteeTabs } from "@/components/TrusteeTabs";
import { pkt } from "@/lib/format";
import { kindLabel } from "@/lib/server/approvals";
import { requirePage } from "@/lib/server/session";
import { signerConfigured, signerPreview, type SignerPreview } from "@/lib/server/signer";
import { trusteeSignerRequest } from "@/lib/server/trustee";

export const metadata: Metadata = { title: "Trustee co-signature" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A signing request that needs the trustee's co-signature (migration 0023): the exact call as the
 * signing service will sign it (decoded from its calldata, with the call hash), the platform
 * approvals so far and the trustee's. The decision carries the payload hash and the call hash
 * shown here: the database issues a one-time trustee ticket and the signing service refuses it if
 * the call changed.
 */
export default async function TrusteeSignerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const valid = UUID.test(id);
  const officer = await requirePage("trustee.read", `/trustee/cosign/signer/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const r = await trusteeSignerRequest(officer.sessionHash, id);
  if (!r) notFound();

  let preview: SignerPreview | null = null;
  let unreachable: string | null = null;
  if (!signerConfigured()) unreachable = "The portal has no client for the signing service (run backend npm run signer:admin-client).";
  else {
    try {
      preview = await signerPreview(id);
      if (!preview) unreachable = "The signing service does not know this request.";
    } catch {
      unreachable = "The signing service could not be reached: the exact call cannot be shown, so no decision is possible now.";
    }
  }
  const call = preview?.call ?? null;
  const blockers = [...r.blockers];
  if (r.status === "pending_approval" && blockers.length === 0 && !call) blockers.push(unreachable ?? preview?.problem ?? "The exact call cannot be built.");
  const approveBlockers = preview?.live.state === "fail" ? [`the policy refuses it now: ${preview.live.reason ?? "?"}`] : [];

  return (
    <Shell officer={officer} current="/trustee/cosign" title="Trustee co-signature">
      <TrusteeTabs current="/trustee/cosign" />
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="what">
          <h2 id="what">
            <span data-testid="signer-title">{kindLabel(r.kind, r.amount)}</span>
            <span className="sp" />
            <span className={r.status === "pending_approval" ? "chip warn" : r.status === "rejected" ? "chip bad" : "chip ok"} data-testid="signer-status">
              {r.status}
            </span>
          </h2>
          <dl className="kv">
            <dt>Request</dt>
            <dd className="mono">{r.id}</dd>
            <dt>Kind</dt>
            <dd className="mono">{r.kind}</dd>
            <dt>Requested by</dt>
            <dd className="mono">
              {r.requestedBy}
              {r.command ? ` for ${r.command.createdBy}` : ""}
            </dd>
            {r.command?.ref ? (
              <>
                <dt>Business reference</dt>
                <dd className="mono">{r.command.ref}</dd>
              </>
            ) : null}
            <dt>Created</dt>
            <dd>{pkt(r.createdAt)}</dd>
            <dt>Approval window ends</dt>
            <dd>{pkt(r.expiresAt)}</dd>
            <dt>Policy</dt>
            <dd className="mono">{r.policy ? `#${String(r.policy.id)} v${String(r.policy.version)}` : "–"}</dd>
            <dt>Payload hash</dt>
            <dd className="mono small" data-testid="payload-hash">
              {r.payloadHash}
            </dd>
          </dl>
        </section>
        <CallView preview={preview} unreachable={unreachable} approvalsNeeded={r.approvalsNeeded} />
      </div>
      <div className="g2">
        <section className="card" aria-labelledby="appr">
          <h2 id="appr">
            Approvals <span className="sp" />
            <span className={r.platformApprovals >= r.approvalsNeeded ? "chip ok" : "chip warn"} data-testid="platform-approvals">
              {`platform ${String(r.platformApprovals)} of ${String(r.approvalsNeeded)}`}
            </span>
            <span className={r.trusteeApprovals >= r.trusteeApprovalsNeeded ? "chip ok" : "chip warn"} data-testid="trustee-approvals">
              {`trustee ${String(r.trusteeApprovals)} of ${String(r.trusteeApprovalsNeeded)}`}
            </span>
          </h2>
          <div className="sig">
            {r.approvals.map((a) => (
              <div key={a.operator} className={a.decision === "approve" ? "y" : "n"}>
                <b className={a.decision === "approve" ? "up" : "dn"}>
                  {a.decision === "approve" ? "✓" : "✕"} {a.operator} <span className="chip">{a.capacity}</span>
                </b>
                <div className="di small">
                  {pkt(a.at)} · {a.reason ?? ""}
                </div>
              </div>
            ))}
          </div>
        </section>
        <section className="card" aria-labelledby="dec">
          <h2 id="dec">Trustee decision</h2>
          <DecisionPanel
            csrf={officer.csrf}
            action={`/api/trustee/cosign/signer/${r.id}/decide`}
            hidden={{ payloadHash: r.payloadHash, callHash: call?.callHash ?? "" }}
            blockers={blockers}
            approveBlockers={approveBlockers}
            approveLabel="Co-sign with security key"
            note="Decided by the signing service; recorded in the signer, trustee and admin audit chains."
          />
        </section>
      </div>
    </Shell>
  );
}
