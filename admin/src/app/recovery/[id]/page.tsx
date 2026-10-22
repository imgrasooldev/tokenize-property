import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActionPanel } from "@/components/ActionPanel";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { StepUpForm } from "@/components/StepUp";
import { pkt } from "@/lib/format";
import type { CommandView } from "@/lib/server/compliance";
import { capacityLabel, caseChip, caseDetail, caseKindLabel, DOC_TYPES, docTypeLabel } from "@/lib/server/recovery";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Recovery case" };

function Cmd({ c }: { c: CommandView | null }) {
  if (!c) return <>–</>;
  return (
    <span className="mono small">
      {c.kind} · <span className={caseChip(c.status)}>{c.status}</span>
      {c.txHash ? ` · ${c.txHash}` : ""}
      {c.lastError ? <span className="dn"> · {c.lastError}</span> : null}
    </span>
  );
}

/**
 * One S-06 case: the facts the officers decide on (investor masked, wallets, read-model balance and
 * freeze, documents as metadata + SHA-256, heirs and the allocation preview, the journal of a
 * reversal), the decisions so far, the on-chain requests with their outbox commands, and the actions
 * this officer may take, each with the database's own reason when it is unavailable.
 */
export default async function RecoveryCasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const valid = /^[1-9]\d{0,17}$/.test(id);
  const officer = await requirePage("recovery.read", `/recovery/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const c = await caseDetail(officer.sessionHash, id);
  if (!c) notFound();
  const maker = c.blockers.maker.length === 0;

  return (
    <Shell officer={officer} current="/recovery" title={`${caseKindLabel(c.kind)} #${String(c.id)}`}>
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="case">
          <h2 id="case">
            Case <span className="sp" />
            <span className={caseChip(c.status)} data-testid="case-status">
              {c.status}
            </span>
          </h2>
          <dl className="kv">
            <dt>Summary</dt>
            <dd>{c.summary}</dd>
            <dt>Opened by (maker)</dt>
            <dd className="mono">
              {c.openedBy} · {pkt(c.openedAt)}
            </dd>
            {c.objectionUntil ? (
              <>
                <dt>Objection window</dt>
                <dd>until {pkt(c.objectionUntil)} (the investor&apos;s contacts of record were notified)</dd>
              </>
            ) : null}
            <dt>caseId on chain</dt>
            <dd className="mono small">{c.caseId}</dd>
            {c.wallet ? (
              <>
                <dt>{c.kind === "succession" ? "Deceased's wallet" : "Old wallet"}</dt>
                <dd className="mono small">
                  {c.wallet}
                  {c.onChain ? ` · ${c.onChain.balance} units · ${c.onChain.frozen ? "frozen" : "not frozen"} (read model)` : ""}
                </dd>
              </>
            ) : null}
            {c.kind === "wallet_recovery" ? (
              <>
                <dt>New wallet</dt>
                <dd className="mono small" data-testid="new-wallet">
                  {c.newWallet ?? "–"}
                  {c.newWallet && c.onChain ? ` · ${c.onChain.newWalletBalance ?? "0"} units · ${c.onChain.newWalletFrozen ? "frozen" : "not frozen"}` : ""}
                </dd>
                <dt>Identity</dt>
                <dd className="mono small">{c.identity}</dd>
                <dt>Re-verified after opening</dt>
                <dd>{c.reverified ? <span className="chip ok">NADRA + liveness passed</span> : <span className="chip warn">not yet</span>}</dd>
              </>
            ) : null}
            {c.evidenceHash ? (
              <>
                <dt>Evidence hash (on chain)</dt>
                <dd className="mono small">{c.evidenceHash}</dd>
              </>
            ) : null}
            {c.unitsTotal ? (
              <>
                <dt>Units at approval</dt>
                <dd>
                  {c.unitsTotal}
                  {c.unitsResidual && c.unitsResidual !== "0" ? ` · ${c.unitsResidual} left in the wallet for a cash-out (RC-14)` : ""}
                </dd>
              </>
            ) : null}
            <dt>Protective freeze</dt>
            <dd>
              <Cmd c={c.commands.freeze} />
            </dd>
            {c.kind === "wallet_recovery" ? (
              <>
                <dt>Management key</dt>
                <dd>
                  <Cmd c={c.commands.addKey} />
                </dd>
              </>
            ) : null}
            {c.cancelledBy ? (
              <>
                <dt>Cancelled</dt>
                <dd>
                  {c.cancelledBy} · {c.cancelReason}
                </dd>
              </>
            ) : null}
            {c.releaseProposedBy ? (
              <>
                <dt>Release</dt>
                <dd>
                  proposed by {c.releaseProposedBy} ({c.releaseReason}){c.releasedBy ? `, confirmed by ${c.releasedBy}` : ", waiting for a second compliance officer"}
                  {c.unfreezeWallet ? ` · unfreeze ${c.unfreezeWallet}` : ""} <Cmd c={c.commands.unfreeze} />
                </dd>
              </>
            ) : null}
          </dl>
          {c.journal ? (
            <>
              <h2 style={{ marginBlockStart: 12 }}>Journal booked in error</h2>
              <dl className="kv">
                <dt>Journal</dt>
                <dd className="mono small">
                  #{c.journal.id} · {c.journal.kind} · {c.journal.key} · ref {c.journal.externalRef ?? "–"} · {pkt(c.journal.createdAt)}
                </dd>
                <dt>Reason</dt>
                <dd className="mono">{c.reasonCode}</dd>
                <dt>Evidence SHA-256</dt>
                <dd className="mono small">{c.evidenceSha256}</dd>
                <dt>Postings</dt>
                <dd className="mono small">{c.journal.postings.map((p) => `${p.account} ${p.amount}`).join(" · ")}</dd>
                <dt>Correcting journal</dt>
                <dd className="mono small">{c.reversalJournal ? `#${String(c.reversalJournal)} (exact contra, kind reversal)` : "– (posted when the checker approves)"}</dd>
              </dl>
            </>
          ) : null}
        </section>

        <section className="card" aria-labelledby="inv">
          <h2 id="inv">{c.kind === "succession" ? "Deceased investor" : c.kind === "reversal" ? "Decisions" : "Investor"}</h2>
          {c.subject ? (
            <dl className="kv">
              <dt>Reference</dt>
              <dd className="mono">{c.subject.ref}</dd>
              <dt>CNIC</dt>
              <dd className="mono">{c.subject.cnic}</dd>
              <dt>KYC status</dt>
              <dd>
                <span className={caseChip(c.subject.status)}>{c.subject.status}</span>
              </dd>
            </dl>
          ) : null}
          <h2 style={{ marginBlockStart: 12 }}>Decisions ({c.needed.map((n) => capacityLabel(n)).join(" + ")})</h2>
          {c.approvals.length === 0 ? (
            <p className="empty">No decision yet.</p>
          ) : (
            <ul className="checks" data-testid="approvals">
              {c.approvals.map((a) => (
                <li key={`${a.capacity}-${a.officer}`}>
                  <i className={a.decision === "approve" ? "ok" : "no"} aria-hidden="true">
                    {a.decision === "approve" ? "✓" : "✕"}
                  </i>
                  <span>
                    <b>{capacityLabel(a.capacity)}</b> {a.officer} · {a.decision} · {pkt(a.at)} · {a.reason}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <h2 style={{ marginBlockStart: 12 }}>Your action</h2>
          <ActionPanel
            csrf={officer.csrf}
            action={`/api/recovery/cases/${String(c.id)}/act`}
            hidden={{ digest: c.digest }}
            note="Recorded in the recovery and admin audit chains; bound to what you see."
            extra={
              c.myCapacities.length > 0 ? (
                <label className="small mu">
                  Decide as{" "}
                  <select name="capacity" defaultValue={c.myCapacities[0]} aria-label="Capacity">
                    {c.myCapacities.map((cap) => (
                      <option key={cap} value={cap}>
                        {capacityLabel(cap)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : undefined
            }
            actions={[
              { action: "approve", label: "Approve", blockers: [...c.blockers.decide, ...c.blockers.approve], tone: "ok" },
              { action: "reject", label: "Reject", blockers: c.blockers.decide, tone: "no" },
              { action: "cancel", label: "Cancel (objection or error)", blockers: c.blockers.cancel },
              { action: "release", label: c.releaseProposedBy ? "Confirm the release (second officer)" : "Propose the release (unfreeze)", blockers: c.blockers.release },
            ]}
          />
        </section>
      </div>

      {c.kind !== "reversal" ? (
        <div className="g2" style={{ marginBlockStart: 12 }}>
          <section className="card" aria-labelledby="docs">
            <h2 id="docs">Documents ({c.documents.length})</h2>
            <p className="di small">Metadata and SHA-256 only: the files stay with legal (document vault T-038).</p>
            {c.documents.length === 0 ? (
              <p className="empty">No document.</p>
            ) : (
              <div className="tbl-wrap">
                <table className="t" data-testid="documents">
                  <thead>
                    <tr>
                      <th scope="col">Type</th>
                      <th scope="col">Reference</th>
                      <th scope="col">SHA-256</th>
                      <th scope="col">Added</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.documents.map((d) => (
                      <tr key={d.id}>
                        <td>{docTypeLabel(d.type)}</td>
                        <td>
                          {d.reference}
                          {d.issuer ? ` · ${d.issuer}` : ""}
                        </td>
                        <td className="mono small">{d.sha256}</td>
                        <td className="mono small">
                          {d.addedBy} · {pkt(d.addedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {maker ? (
              <form method="post" action={`/api/recovery/cases/${String(c.id)}/evidence`} className="stack" style={{ marginBlockStart: 10 }}>
                <input type="hidden" name="csrf" value={officer.csrf} />
                <input type="hidden" name="what" value="document" />
                <select name="docType" aria-label="Document type" required defaultValue="">
                  <option value="" disabled>
                    Document type…
                  </option>
                  {DOC_TYPES.map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </select>
                <input name="reference" required minLength={3} maxLength={120} placeholder="Reference (certificate / order number)" aria-label="Reference" />
                <input name="issuer" maxLength={120} placeholder="Issuer (court, NADRA office), optional" aria-label="Issuer" />
                <input name="sha256" required pattern="[0-9a-fA-F]{64}" placeholder="SHA-256 of the document" aria-label="SHA-256" />
                <div className="row">
                  <button className="btn" type="submit">
                    Add document
                  </button>
                </div>
              </form>
            ) : (
              <p className="small mu">{c.blockers.maker.join(" ")}</p>
            )}
          </section>

          <section className="card" aria-labelledby="side">
            {c.kind === "succession" ? (
              <>
                <h2 id="side">Heirs ({c.heirs.length})</h2>
                {c.heirs.length === 0 ? (
                  <p className="empty">No heir yet.</p>
                ) : (
                  <div className="tbl-wrap">
                    <table className="t" data-testid="heirs">
                      <thead>
                        <tr>
                          <th scope="col">Heir</th>
                          <th scope="col">CNIC</th>
                          <th scope="col">KYC</th>
                          <th scope="col">Wallet</th>
                          <th scope="col">Share</th>
                          <th scope="col">Units (preview)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {c.heirs.map((h) => (
                          <tr key={h.id}>
                            <td className="mono">{h.subject}</td>
                            <td className="mono">{h.cnic}</td>
                            <td>
                              <span className={caseChip(h.status)}>{h.status}</span>
                            </td>
                            <td className="mono small">{h.wallet}</td>
                            <td className="mono">{h.share}</td>
                            <td className="mono">{c.allocationPreview?.find((a) => a.heir === h.id)?.units ?? "–"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="di small">
                  Units: floor(balance × share) each; the remainder goes by largest remainder only with a recorded family settlement, otherwise it stays frozen in the deceased&apos;s
                  wallet for a cash-out.
                </p>
                {maker ? (
                  <form method="post" action={`/api/recovery/cases/${String(c.id)}/evidence`} className="stack">
                    <input type="hidden" name="csrf" value={officer.csrf} />
                    <input type="hidden" name="what" value="heir" />
                    <input name="subject" required pattern="[0-9a-fA-F-]{36}" placeholder="Heir reference (KYC subject id)" aria-label="Heir" />
                    <div className="row">
                      <input name="num" required inputMode="numeric" pattern="[1-9][0-9]*" placeholder="numerator" aria-label="Share numerator" />
                      <span>/</span>
                      <input name="den" required inputMode="numeric" pattern="[1-9][0-9]*" placeholder="denominator" aria-label="Share denominator" />
                      <button className="btn" type="submit">
                        Add heir
                      </button>
                    </div>
                  </form>
                ) : null}
              </>
            ) : (
              <>
                <h2 id="side">New custodial wallet</h2>
                <p className="di small">
                  The signing service creates the wallet; it is bound to the investor only when the recovery executes on chain. It can change only before any decision.
                </p>
                {maker ? (
                  <StepUpForm csrf={officer.csrf} action={`/api/recovery/cases/${String(c.id)}/wallet`}>
                    <div className="row">
                      <button className="btn" type="submit" name="decision" value="create">
                        {c.newWallet ? "Replace with a new wallet (security key)" : "Create the new wallet (security key)"}
                      </button>
                    </div>
                  </StepUpForm>
                ) : null}
              </>
            )}
            <h2 style={{ marginBlockStart: 12 }}>On-chain requests</h2>
            {c.requests.length === 0 ? (
              <p className="empty">None yet (created by the final approval).</p>
            ) : (
              <ul className="checks" data-testid="requests">
                {c.requests.map((r) => (
                  <li key={r.id}>
                    <i className={r.status === "executed" ? "ok" : r.status === "cancelled" || r.status === "failed" ? "no" : "wait"} aria-hidden="true">
                      ●
                    </i>
                    <span className="small">
                      <b>{r.kind === "wallet_recovery" ? "Wallet recovery" : `Forced transfer ${r.amount} units`}</b> → <span className="mono">{r.to}</span> ·{" "}
                      <span className={caseChip(r.status)}>{r.status}</span>
                      {r.requestId ? ` · request ${r.requestId}` : ""}
                      {r.eta ? ` · executable from ${pkt(r.eta)}` : ""}
                      <br />
                      propose <Cmd c={r.propose} /> · execute <Cmd c={r.execute} /> · cancel <Cmd c={r.cancel} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}
    </Shell>
  );
}
