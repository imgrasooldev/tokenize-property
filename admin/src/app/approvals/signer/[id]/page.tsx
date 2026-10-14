import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DecisionPanel, Flash, GateChip } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { pkt } from "@/lib/format";
import { kindLabel, signerRequest } from "@/lib/server/approvals";
import { requirePage } from "@/lib/server/session";
import { signerConfigured, signerPreview, type SignerPreview } from "@/lib/server/signer";

export const metadata: Metadata = { title: "Signing request" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * One signing request, as the checker will sign it: the exact call (decoded from the bytes the
 * signing service builds), its hash, the policy and live checks, who asked, existing approvals and
 * why a decision may be unavailable. The decision carries the payload hash and the call hash shown
 * here; the database and the signing service refuse it if either changed.
 */
export default async function SignerRequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const valid = UUID.test(id);
  const officer = await requirePage("approvals.read", `/approvals/signer/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const r = await signerRequest(officer.sessionHash, id);
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
  if (r.status === "pending_approval" && !call) blockers.push(unreachable ?? preview?.problem ?? "The exact call cannot be built.");
  const approveBlockers = preview?.live.state === "fail" ? [`the policy refuses it now: ${preview.live.reason ?? "?"}`] : [];

  return (
    <Shell officer={officer} current="/approvals" title="Signing request" actions={<GateChip gate={r.gate} />}>
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
            <dt>Command</dt>
            <dd className="mono">{r.commandRef}</dd>
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
            <dt>Signing key</dt>
            <dd className="mono">
              {r.keyRef} {r.keyAddress ? `· ${r.keyAddress}` : ""}
            </dd>
            <dt>Policy</dt>
            <dd className="mono">
              {r.policy ? `#${String(r.policy.id)} v${String(r.policy.version)} (maker ${r.policy.proposedBy}, checker ${r.policy.approvedBy ?? "–"})` : "–"}
              {r.policy && !r.policy.active ? <span className="chip warn">replaced since</span> : null}
            </dd>
            <dt>Payload hash</dt>
            <dd className="mono small" data-testid="payload-hash">
              {r.payloadHash}
            </dd>
          </dl>
          <h2 style={{ marginBlockStart: 12 }}>Payload as requested</h2>
          <dl className="kv">
            {Object.entries(r.payload).map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <dt className="mono">{k}</dt>
                <dd className="mono">{typeof v === "string" ? v : JSON.stringify(v)}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="card" aria-labelledby="sign">
          <h2 id="sign">
            Exactly what will be signed <span className="sp" />
            {preview?.live ? (
              <span
                className={preview.live.state === "pass" ? "chip ok" : preview.live.state === "fail" ? "chip bad" : "chip"}
                data-testid="live-checks"
                title={preview.live.reason ?? ""}
              >
                {preview.live.state === "pass"
                  ? `policy checks pass now · ${String(preview.live.approvalsNeeded ?? r.approvalsNeeded)} approvals`
                  : preview.live.state === "fail"
                    ? "policy refuses now"
                    : preview.live.state === "skipped"
                      ? "checked at signing"
                      : "live checks unavailable"}
              </span>
            ) : null}
          </h2>
          {call ? (
            <>
              <dl className="kv">
                <dt>Contract</dt>
                <dd className="mono">
                  {call.contract} · {call.to}
                </dd>
                <dt>Function</dt>
                <dd className="mono" data-testid="call-function">
                  {`${call.functionName}(${call.args.map((a) => a.type).join(", ")})`}
                </dd>
                {call.args.map((a) => (
                  <div key={a.name} style={{ display: "contents" }}>
                    <dt className="mono">{a.name}</dt>
                    <dd className="mono" data-testid={`arg-${a.name}`}>
                      {a.value}
                    </dd>
                  </div>
                ))}
                <dt>From</dt>
                <dd className="mono">{call.from ?? "key not loaded"}</dd>
                <dt>Chain · gas limit</dt>
                <dd className="mono">
                  {call.chainId} · {Number(call.gasLimit).toLocaleString("en-PK")} (fixed by policy)
                </dd>
              </dl>
              <div className="diff" style={{ marginBlockStart: 10 }} data-testid="calldata">
                <span className="di">to</span> {call.to}
                <br />
                <span className="di">data</span> {call.data ?? `${call.selector}… (claim signature made at signing time)`}
                <br />
                <span className="di">call hash</span> <span className="cy" data-testid="call-hash">{call.callHash}</span>
              </div>
              {call.note ? <p className="small mu">{call.note}</p> : null}
              {preview?.live.state === "fail" || preview?.live.state === "unavailable" ? (
                <p className={preview.live.state === "fail" ? "alert bad" : "alert info"}>{preview.live.reason}</p>
              ) : null}
              <b className="small" style={{ display: "block", marginBlockStart: 10 }}>
                Policy rules (checked again just before signing)
              </b>
              <ul className="checks" style={{ marginBlockStart: 6 }}>
                {call.rules.map((x) => (
                  <li key={x}>
                    <i aria-hidden="true">✓</i>
                    <span className="small">{x}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="alert info" data-testid="signer-unavailable">
              {unreachable ?? preview?.problem ?? "No call to show."}
            </p>
          )}
        </section>
      </div>

      <div className="g2">
        <section className="card" aria-labelledby="appr">
          <h2 id="appr">
            Approvals ({r.platformApprovals} of {r.approvalsNeeded}) <span className="sp" />
            <span className="chip warn">different officers required</span>
            {r.trusteeApprovalsNeeded > 0 ? (
              <span className={r.trusteeApprovals >= r.trusteeApprovalsNeeded ? "chip ok" : "chip warn"} data-testid="trustee-approvals">
                trustee co-signature {r.trusteeApprovals} of {r.trusteeApprovalsNeeded}
              </span>
            ) : null}
          </h2>
          <div className="sig">
            {r.approvals.map((a) => (
              <div key={a.operator} className={a.decision === "approve" ? "y" : "n"}>
                <b className={a.decision === "approve" ? "up" : "dn"}>
                  {a.decision === "approve" ? "✓" : "✕"} {a.operator} {a.capacity === "trustee" ? <span className="chip">trustee</span> : null}
                </b>
                <div className="di small">
                  {pkt(a.at)} · {a.reason ?? ""}
                </div>
              </div>
            ))}
            {Array.from({ length: Math.max(0, r.approvalsNeeded - r.platformApprovals) }, (_, i) => (
              <div key={`open-${String(i)}`}>
                <b>waiting</b>
                <div className="di small">a checker who is not the maker</div>
              </div>
            ))}
          </div>
        </section>

        <section className="card" aria-labelledby="dec">
          <h2 id="dec">Your decision</h2>
          <DecisionPanel
            csrf={officer.csrf}
            action={`/api/approvals/signer/${r.id}/decide`}
            hidden={{ payloadHash: r.payloadHash, callHash: call?.callHash ?? "" }}
            blockers={blockers}
            approveBlockers={approveBlockers}
            note="Recorded in the signer and admin audit chains."
          />
        </section>
      </div>
    </Shell>
  );
}
