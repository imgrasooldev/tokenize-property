import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActionPanel } from "@/components/ActionPanel";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { StepUpForm } from "@/components/StepUp";
import { pkt } from "@/lib/format";
import type { CommandView, SubjectView } from "@/lib/server/compliance";
import { rupees } from "@/lib/server/operations";
import { capacityLabel, checkLabel, considerationLabel, transferChip, transferDetail, type Check } from "@/lib/server/transfers";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Transfer case" };

function Cmd({ c }: { c: CommandView | null }) {
  if (!c) return <>–</>;
  return (
    <span className="mono small">
      {c.kind} · <span className={transferChip(c.status)}>{c.status}</span>
      {c.txHash ? ` · ${c.txHash}` : ""}
      {c.lastError ? <span className="dn"> · {c.lastError}</span> : null}
    </span>
  );
}

function Party({ label, s, wallet }: { label: string; s: SubjectView | null; wallet: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {s ? (
          <>
            <span className="mono">{s.ref}</span> · <span className="mono">{s.cnic}</span> · <span className={transferChip(s.status === "verified" ? "approved" : "review")}>{s.status}</span>
          </>
        ) : (
          "–"
        )}
        <br />
        <span className="mono small">{wallet}</span>
      </dd>
    </>
  );
}

function Checks({ list, testId }: { list: Check[]; testId: string }) {
  return (
    <ul className="checks" data-testid={testId}>
      {list.map((k) => (
        <li key={k.code}>
          <i className={k.ok ? "ok" : "no"} aria-hidden="true">
            {k.ok ? "✓" : "✕"}
          </i>
          <span className="small">
            <b>{checkLabel(k.code)}</b> <span className="mono">({k.code})</span> · {k.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Blocked({ title, reasons }: { title: string; reasons: string[] }) {
  return (
    <ul className="checks" data-testid="actions-unavailable">
      <li>
        <i className="no" aria-hidden="true">
          ✕
        </i>
        <span className="small">
          <b>{title}:</b> {reasons.join(" ")}
        </span>
      </li>
    </ul>
  );
}

/**
 * One S-04 case: the parties (masked), the terms, the payment into escrow, the on-chain request and
 * its outbox commands, the checks (live and the latest recorded run), the decisions, the cash leg
 * (settlement or refund with fee, withholding and net), the events and, for compliance officers and
 * auditors only, the surveillance alerts. Every action carries the digest of what is shown, and the
 * database's own reason is listed when an action is unavailable.
 */
export default async function TransferCasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const valid = /^[1-9]\d{0,17}$/.test(id);
  const officer = await requirePage("transfer.read", `/transfers/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const c = await transferDetail(officer.sessionHash, id);
  if (!c) notFound();
  const sale = c.consideration === "sale";
  const prepared = c.cash.find((o) => o.status === "prepared") ?? null;
  const settledOrRefund = c.status === "refunding" ? "refund" : "settlement";

  return (
    <Shell officer={officer} current="/transfers" title={`Transfer #${String(c.id)}`}>
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="case">
          <h2 id="case">
            Case <span className="sp" />
            <span className={transferChip(c.status)} data-testid="case-status">
              {c.status}
            </span>
          </h2>
          <dl className="kv">
            <dt>Investors see</dt>
            <dd className="mono small">{c.publicStatus}</dd>
            <dt>Kind</dt>
            <dd>
              {considerationLabel(c.consideration)} · opened by the {c.origin === "desk" ? "transfer desk" : "seller on the website"}
            </dd>
            <Party label="Seller" s={c.seller} wallet={c.sellerWallet} />
            <Party label="Buyer" s={c.buyer} wallet={c.buyerWallet} />
            <dt>Units</dt>
            <dd className="mono">{c.units}</dd>
            {sale ? (
              <>
                <dt>Price per unit</dt>
                <dd className="mono">{rupees(c.pricePaisa)}</dd>
                <dt>Total</dt>
                <dd className="mono" data-testid="total">
                  {rupees(c.totalPaisa)}
                </dd>
              </>
            ) : (
              <>
                <dt>No price because</dt>
                <dd>{c.noPriceReason}</dd>
              </>
            )}
            {c.priceExplanation ? (
              <>
                <dt>Price explanation</dt>
                <dd>{c.priceExplanation}</dd>
              </>
            ) : null}
            {c.holdingReason ? (
              <>
                <dt>Minimum-holding reason</dt>
                <dd>{c.holdingReason}</dd>
              </>
            ) : null}
            <dt>Agreement SHA-256</dt>
            <dd className="mono small">{c.agreementSha256}</dd>
            <dt>Token</dt>
            <dd className="mono small">{c.token}</dd>
            <dt>caseId on chain</dt>
            <dd className="mono small">{c.caseId}</dd>
            <dt>Opened (maker)</dt>
            <dd className="mono small">
              {c.openedBy} · {pkt(c.openedAt)}
            </dd>
            <dt>Buyer accepted</dt>
            <dd>{c.acceptedAt ? pkt(c.acceptedAt) : <span className="chip warn">not yet</span>}</dd>
            <dt>Completed (T1)</dt>
            <dd className="mono small">{c.completedBy ? `${c.completedBy} · ${pkt(c.completedAt)}` : "–"}</dd>
            {c.approvedAt ? (
              <>
                <dt>Approved</dt>
                <dd>{pkt(c.approvedAt)}</dd>
              </>
            ) : null}
            {c.evidenceHash ? (
              <>
                <dt>Evidence hash (on chain)</dt>
                <dd className="mono small">{c.evidenceHash}</dd>
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
            {c.disputedBy ? (
              <>
                <dt>Disputed</dt>
                <dd>
                  {c.disputedBy} · {c.disputeReason}
                </dd>
              </>
            ) : null}
          </dl>
        </section>

        <section className="card" aria-labelledby="decisions">
          <h2 id="decisions">Decisions (compliance + trustee)</h2>
          {c.decisions.length === 0 ? (
            <p className="empty">No decision yet.</p>
          ) : (
            <ul className="checks" data-testid="decisions">
              {c.decisions.map((d) => (
                <li key={`${d.capacity}-${d.officer}`}>
                  <i className={d.decision === "approve" ? "ok" : "no"} aria-hidden="true">
                    {d.decision === "approve" ? "✓" : "✕"}
                  </i>
                  <span>
                    <b>{capacityLabel(d.capacity)}</b> {d.officer} · {d.decision} · {pkt(d.at)} · {d.reason}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <h2 style={{ marginBlockStart: 12 }}>Transfer desk</h2>
          {c.blockers.maker.length === 0 ? (
            <StepUpForm csrf={officer.csrf} action={`/api/transfers/cases/${String(c.id)}/desk`}>
              <input type="hidden" name="digest" value={c.digest} />
              <p className="di small">Completing records the checks and the surveillance; the signed agreement must match the SHA-256 above.</p>
              <div className="row">
                <button className="btn ok" type="submit" name="decision" value="complete">
                  Complete the request (T1) with security key
                </button>
              </div>
            </StepUpForm>
          ) : (
            <Blocked title="Complete the request" reasons={c.blockers.maker} />
          )}
          {officer.permissions.has("transfer.request") && ["requested", "checks", "awaiting_cash"].includes(c.status) && !c.payment?.paidRef ? (
            <ActionPanel
              csrf={officer.csrf}
              action={`/api/transfers/cases/${String(c.id)}/desk`}
              hidden={{ digest: c.digest }}
              reasonId="withdraw-reason"
              note="Only for a party who asked in writing; before any payment is booked."
              actions={[{ action: "withdraw", label: "Withdraw for a party (T2)", blockers: [] }]}
            />
          ) : null}

          <h2 style={{ marginBlockStart: 12 }}>Your decision</h2>
          <ActionPanel
            csrf={officer.csrf}
            action={`/api/transfers/cases/${String(c.id)}/decide`}
            hidden={{ digest: c.digest }}
            reasonId="decide-reason"
            note="Recorded in the transfer and admin audit chains; bound to what you see."
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
              { action: "approve", label: "Approve", blockers: c.blockers.decide, tone: "ok" },
              { action: "reject", label: "Reject", blockers: c.blockers.decide, tone: "no" },
              { action: "cancel", label: "Cancel before execution (T9)", blockers: c.blockers.cancel },
              { action: "dispute", label: "Record a dispute (T15)", blockers: c.blockers.dispute },
            ]}
          />
        </section>
      </div>

      <div className="g2" style={{ marginBlockStart: 12 }}>
        <section className="card" aria-labelledby="checks">
          <h2 id="checks">Checks</h2>
          {c.liveChecks ? (
            <>
              <p className="di small">Live (approval stage), computed now by the database:</p>
              <Checks list={c.liveChecks} testId="live-checks" />
            </>
          ) : null}
          {c.checks ? (
            <>
              <p className="di small" style={{ marginBlockStart: 8 }}>
                Latest recorded run: stage {c.checks.stage}, {c.checks.passed ? "passed" : "failed"}, {pkt(c.checks.at)}
              </p>
              <Checks list={c.checks.results} testId="recorded-checks" />
            </>
          ) : (
            <p className="empty">No recorded run yet (the desk records one on completion).</p>
          )}
        </section>

        <section className="card" aria-labelledby="chain">
          <h2 id="chain">Payment and chain</h2>
          <dl className="kv">
            {sale ? (
              <>
                <dt>Payment code</dt>
                <dd className="mono">{c.payment ? c.payment.code : "– (issued on approval)"}</dd>
                {c.payment ? (
                  <>
                    <dt>Pay until</dt>
                    <dd>{pkt(c.payment.payUntil)}</dd>
                    <dt>Paid</dt>
                    <dd className="mono small">{c.payment.paidRef ? `${c.payment.paidRef} · ${pkt(c.payment.paidAt)}` : "not yet"}</dd>
                    <dt>Escrow held</dt>
                    <dd className="mono" data-testid="escrow">
                      {rupees(c.payment.escrowPaisa)}
                    </dd>
                  </>
                ) : null}
              </>
            ) : (
              <>
                <dt>Cash leg</dt>
                <dd>none (no consideration)</dd>
              </>
            )}
            <dt>RecoveryGuard</dt>
            <dd className="mono small">{c.recoveryGuard}</dd>
            <dt>Request</dt>
            <dd className="mono small">
              {c.request.requestId ? `#${c.request.requestId}` : "–"}
              {c.request.eta ? ` · executable from ${pkt(c.request.eta)}` : ""}
            </dd>
            <dt>Attempts</dt>
            <dd className="mono small">
              execute {c.request.executeAttempts} · cancel {c.request.cancelAttempts}
            </dd>
            {c.request.executedTx ? (
              <>
                <dt>Executed</dt>
                <dd className="mono small">
                  {c.request.executedTx} · {pkt(c.request.executedAt)}
                </dd>
              </>
            ) : null}
            <dt>Propose</dt>
            <dd>
              <Cmd c={c.commands.propose} />
            </dd>
            <dt>Execute</dt>
            <dd>
              <Cmd c={c.commands.execute} />
            </dd>
            <dt>Cancel</dt>
            <dd>
              <Cmd c={c.commands.cancel} />
            </dd>
            <dt>Signing policies</dt>
            <dd>
              {Object.entries(c.policies)
                .map(([k, v]) => `transfer.${k} ${v ? "active" : "MISSING"}`)
                .join(" · ")}
            </dd>
          </dl>
        </section>
      </div>

      {sale ? (
        <section className="card" aria-labelledby="cash" style={{ marginBlockStart: 12 }}>
          <h2 id="cash">Cash leg: seller settlement and buyer refund</h2>
          {c.cash.length === 0 ? (
            <p className="empty">No settlement or refund yet.</p>
          ) : (
            <div className="tbl-wrap">
              <table className="t" data-testid="cash-ops">
                <thead>
                  <tr>
                    <th scope="col">Kind</th>
                    <th scope="col">Reference</th>
                    <th scope="col">State</th>
                    <th scope="col">Gross</th>
                    <th scope="col">Fee</th>
                    <th scope="col">Withholding</th>
                    <th scope="col">Net</th>
                    <th scope="col">To</th>
                    <th scope="col">Prepared / decided</th>
                  </tr>
                </thead>
                <tbody>
                  {c.cash.map((o) => (
                    <tr key={o.id}>
                      <td>
                        {o.kind} #{o.attempt}
                      </td>
                      <td className="mono small">{o.reference}</td>
                      <td>
                        <span className={transferChip(o.status)}>{o.status}</span>
                      </td>
                      <td className="mono small">{rupees(o.grossPaisa)}</td>
                      <td className="mono small">{o.feePaisa === null ? "–" : rupees(o.feePaisa)}</td>
                      <td className="mono small">
                        {o.taxPaisa === null ? "–" : rupees(o.taxPaisa)}
                        {o.taxStatus ? ` (${o.taxStatus})` : ""}
                        {o.taxPlaceholder ? (
                          <span className="chip warn" data-testid="placeholder-rate">
                            {" "}
                            PLACEHOLDER rate
                          </span>
                        ) : null}
                      </td>
                      <td className="mono small">{rupees(o.netPaisa)}</td>
                      <td className="mono small">{o.payee ? `${o.payee.bank} ····${o.payee.last4}` : o.raastRef ? `source of ${o.raastRef}` : "–"}</td>
                      <td className="mono small">
                        {o.preparedBy} · {pkt(o.preparedAt)}
                        {o.decidedBy ? ` / ${o.decidedBy} · ${pkt(o.decidedAt)}${o.decisionReason ? ` · ${o.decisionReason}` : ""}` : ""}
                        {o.fileSha256 ? (
                          <>
                            <br />
                            instruction SHA-256 {o.fileSha256}
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="g2" style={{ marginBlockStart: 10 }}>
            <div className="stack">
              <b className="small">Prepare (operations maker)</b>
              {c.blockers.prepare.length === 0 ? (
                <StepUpForm csrf={officer.csrf} action={`/api/transfers/cases/${String(c.id)}/cash`}>
                  <input type="hidden" name="digest" value={c.digest} />
                  <p className="di small">
                    {settledOrRefund === "settlement"
                      ? "Gross, platform fee, withholding at the active rate for the seller's status, net to the seller's active payout account."
                      : "The buyer's credit back to its source account, under the original Raast reference."}
                  </p>
                  <div className="row">
                    <button className="btn" type="submit" name="decision" value={settledOrRefund === "settlement" ? "prepare_settlement" : "prepare_refund"}>
                      Prepare the {settledOrRefund} with security key
                    </button>
                  </div>
                </StepUpForm>
              ) : (
                <Blocked title="Prepare" reasons={c.blockers.prepare} />
              )}
            </div>
            <div className="stack">
              <b className="small">Confirm (operations checker){prepared ? `: ${prepared.kind} ${prepared.reference}, net ${rupees(prepared.netPaisa)}` : ""}</b>
              {c.blockers.confirm.length === 0 ? (
                <ActionPanel
                  csrf={officer.csrf}
                  action={`/api/transfers/cases/${String(c.id)}/cash`}
                  hidden={{ digest: c.digest }}
                  reasonId="cash-reason"
                  note="Posts the journals and records the bank instruction's SHA-256 before anything is sent."
                  actions={[
                    { action: "approve", label: "Approve", blockers: [], tone: "ok" },
                    { action: "reject", label: "Reject", blockers: [], tone: "no" },
                  ]}
                />
              ) : (
                <Blocked title="Confirm" reasons={c.blockers.confirm} />
              )}
            </div>
          </div>
        </section>
      ) : null}

      {c.alerts ? (
        <section className="card" aria-labelledby="alerts" style={{ marginBlockStart: 12 }}>
          <h2 id="alerts">Surveillance alerts ({c.alerts.length})</h2>
          <p className="di small">Compliance officers and auditors only; never shown to investors or other roles (tipping-off). Each alert opened an STR case.</p>
          {c.alerts.length === 0 ? (
            <p className="empty">No alert.</p>
          ) : (
            <ul className="checks" data-testid="alerts">
              {c.alerts.map((a) => (
                <li key={`${a.rule}-${String(a.strCase)}`}>
                  <i className="wait" aria-hidden="true">
                    !
                  </i>
                  <span className="small">
                    <b>{a.rule}</b> · {a.detail} · <a href={`/compliance/str/${String(a.strCase)}`}>STR case #{a.strCase}</a> · {pkt(a.at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section className="card" aria-labelledby="events" style={{ marginBlockStart: 12 }}>
        <h2 id="events">Events</h2>
        {c.events.length === 0 ? (
          <p className="empty">No event.</p>
        ) : (
          <ul className="checks" data-testid="events">
            {c.events.map((e, i) => (
              <li key={`${String(i)}-${e.to}`}>
                <i className={transferChip(e.to) === "chip ok" ? "ok" : transferChip(e.to) === "chip bad" ? "no" : "wait"} aria-hidden="true">
                  ●
                </i>
                <span className="small">
                  {e.from ?? "–"} → <b>{e.to}</b> · {e.actor} · {pkt(e.at)} · {e.reason}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Shell>
  );
}
