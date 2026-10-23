import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ActionPanel, type PanelAction } from "@/components/ActionPanel";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { StepUpForm } from "@/components/StepUp";
import { pkt, short } from "@/lib/format";
import { exitCapacityLabel, exitChip, exitStateLabel, fieldsOf, LINE_KINDS, type DetailField } from "@/lib/exit";
import { exitCase, type ExitCase, type ExitDecision } from "@/lib/server/exit";
import { rupees } from "@/lib/server/operations";
import { requirePage, type Officer } from "@/lib/server/session";

export const metadata: Metadata = { title: "Exit case" };

const PAISA_KEYS = new Set(["salePricePaisa", "depositPaisa"]);

function detailValue(k: string, v: unknown): string {
  if (typeof v === "string" && PAISA_KEYS.has(k)) return rupees(v);
  if (typeof v === "string" && /^[0-9a-f]{64}$/.test(v)) return short(v, 8);
  return typeof v === "string" ? v : JSON.stringify(v);
}

function factValue(k: string, v: string | boolean | number): string {
  if (typeof v === "string" && (k.endsWith("Paisa") || k === "salePricePaisa")) return rupees(v);
  if (typeof v === "string" && /^[0-9a-f]{64}$/.test(v)) return short(v, 8);
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return pkt(v);
  return String(v);
}

/** One decision form posting to /api/exit/decide with what the officer reviewed. */
function Decide({
  officer,
  c,
  kind,
  refId,
  digest,
  actions,
  note,
  extra,
  idSuffix,
}: {
  officer: Officer;
  c: ExitCase;
  kind: string;
  refId: number;
  digest: string;
  actions: PanelAction[];
  note: string;
  extra?: ReactNode;
  idSuffix: string;
}) {
  return (
    <ActionPanel
      csrf={officer.csrf}
      action="/api/exit/decide"
      hidden={{ kind, ref: String(refId), case: String(c.id), digest }}
      actions={actions}
      note={note}
      extra={extra}
      reasonId={`reason-${idSuffix}`}
    />
  );
}

function DetailInput({ f, prefill }: { f: DetailField; prefill: string | null }) {
  switch (f.kind) {
    case "sha":
      return <input name={f.key} required pattern="[0-9a-fA-F]{64}" placeholder={f.label} aria-label={f.label} />;
    case "block":
    case "units":
      return <input name={f.key} required inputMode="numeric" pattern="[0-9]{1,31}" placeholder={f.label} aria-label={f.label} />;
    case "rupees":
    case "rupees0":
      return <input name={f.key} required inputMode="decimal" placeholder={f.label} aria-label={f.label} />;
    case "date":
      return (
        <label className="small mu">
          {f.label} <input type="date" name={f.key} required aria-label={f.label} />
        </label>
      );
    case "bool":
      return (
        <select name={f.key} required defaultValue="" aria-label={f.label}>
          <option value="" disabled>
            {f.label}?
          </option>
          <option value="false">No</option>
          <option value="true">Yes</option>
        </select>
      );
    case "confirm":
      return (
        <label className="small">
          <input type="checkbox" name={f.key} value="true" required /> {f.label}
        </label>
      );
    case "buyerRef":
      return <input name={f.key} required pattern="[A-Za-z0-9][A-Za-z0-9:._\-]{2,63}" placeholder={f.label} aria-label={f.label} />;
    case "depositTreatment":
      return (
        <select name={f.key} required defaultValue="" aria-label={f.label}>
          <option value="" disabled>
            {f.label}…
          </option>
          <option value="forfeit">Forfeit</option>
          <option value="refund">Refund</option>
          <option value="none">None</option>
        </select>
      );
    case "wallet":
      return <input name={f.key} required pattern="0x[0-9a-fA-F]{40}" defaultValue={prefill ?? undefined} placeholder={f.label} aria-label={f.label} />;
  }
}

function voteBlockers(officer: Officer, c: ExitCase, d: ExitDecision): string[] {
  if (d.status !== "open") return [`The decision is ${d.status}.`];
  if (!officer.permissions.has("exit.decide")) return ["Your role does not decide exit cases."];
  if (c.me.conflicted) return ["You declared a conflict on this case (EX-SOD-2)."];
  if (d.proposedBy === c.me.handle || c.openedBy === c.me.handle) return ["Maker-checker: whoever opened the case or proposed this decision cannot decide it (EX-SOD-1)."];
  if (d.votes.some((v) => v.officer === c.me.handle)) return ["You already voted; a different officer decides in the other capacity."];
  if (d.myCapacities.length === 0) return [`${d.code} is decided by ${d.capacities.map(exitCapacityLabel).join(" + ")}: you hold no capacity that is still open.`];
  return [];
}

/**
 * One S-05 exit case: the facts and the event history, decisions with their votes by capacity, the
 * maker's steps (propose, proceeds, waterfall, payments, record date), the final distribution and
 * the redemption batch with each line's payment and burn status. Every action posts with a reason,
 * the digest of what is shown and a fresh security-key step-up; the database decides.
 */
export default async function ExitCasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const valid = /^[1-9]\d{0,17}$/.test(id);
  const officer = await requirePage("exit.read", `/exit/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const c = await exitCase(officer.sessionHash, id);
  if (!c) notFound();
  const maker = officer.permissions.has("exit.request");
  const decider = officer.permissions.has("exit.decide");
  const isChecker = c.me.roles.includes("ops_checker");
  const isTrustee = c.me.roles.includes("trustee_officer");
  const openDecision = c.decisions.find((d) => d.status === "open") ?? null;
  const proposeCode = typeof q.propose === "string" && c.possibleDecisions.some((p) => p.code === q.propose) ? q.propose : null;
  const prefillWallet = typeof q.wallet === "string" && /^0x[0-9a-f]{40}$/.test(q.wallet) ? q.wallet : null;
  const requestAction = `/api/exit/cases/${String(c.id)}/request`;
  const w = c.waterfall;
  const f = c.final;
  const r = c.redemption;
  const conflictNote = c.me.conflicted ? ["You declared a conflict on this case."] : [];
  const checkerOnly = isChecker ? [] : ["Only an operations checker decides this."];
  const paidLines = w && w.status === "approved" ? w.lines.filter((l) => !l.withdrawn && l.journal !== null && !["reserve_release", "rent_transfer"].includes(l.kind)) : [];

  return (
    <Shell officer={officer} current="/exit" title={`Exit case #${String(c.id)}`}>
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="case">
          <h2 id="case">
            Case <span className="sp" />
            <span className={exitChip(c.state)} data-testid="case-state">
              {exitStateLabel(c.state)}
            </span>
          </h2>
          <dl className="kv">
            <dt>Token</dt>
            <dd className="mono small">{c.token}</dd>
            <dt>Rationale</dt>
            <dd>{c.rationale}</dd>
            <dt>Offer</dt>
            <dd className="mono">{rupees(c.offerPaisa)}</dd>
            <dt>Valuation A</dt>
            <dd className="mono small">
              {rupees(c.valuationA)} · {short(c.valuationASha, 8)}
            </dd>
            <dt>Valuation B</dt>
            <dd className="mono small">
              {rupees(c.valuationB)} · {short(c.valuationBSha, 8)}
            </dd>
            <dt>Price floor (EX-5)</dt>
            <dd className="mono">{rupees(c.priceFloor)}</dd>
            <dt>Estimated costs</dt>
            <dd className="mono">{rupees(c.costsPaisa)}</dd>
            <dt>Investor vote</dt>
            <dd>{c.voteRequired ? "required (X2)" : "not required (X3)"}</dd>
            <dt>Opened by (maker)</dt>
            <dd className="mono">
              {c.openedBy} · {pkt(c.openedAt)}
            </dd>
            {Object.entries(c.facts).map(([k, v]) => (
              <FactRow key={k} k={k} v={factValue(k, v)} />
            ))}
            <dt>Exit pool / closure reserve</dt>
            <dd className="mono">
              {rupees(c.pool)} / {rupees(c.closureReserve)}
            </dd>
            <dt>Read model</dt>
            <dd className="mono small">
              {c.chain
                ? `supply ${c.chain.supply} · cap ${c.chain.cap ?? "–"} · ${c.chain.paused ? "paused" : "not paused"} · indexed to block ${c.chain.cursor === null ? "–" : String(c.chain.cursor)}`
                : "token not in the read model"}{" "}
              · trustee register {c.registerUnits} units
            </dd>
          </dl>
          {c.closeProblem ? (
            <p className="alert bad" data-testid="close-problem">
              Closure (X18) not possible yet: {c.closeProblem}
            </p>
          ) : null}
          <h2 style={{ marginBlockStart: 12 }}>History</h2>
          {c.events.length === 0 ? (
            <p className="empty">No transition yet.</p>
          ) : (
            <ul className="checks" data-testid="events">
              {c.events.map((e, i) => (
                <li key={`${e.code}-${String(i)}`}>
                  <i className="ok" aria-hidden="true">
                    ●
                  </i>
                  <span className="small">
                    <b>{e.code}</b> {exitStateLabel(e.from)} → {exitStateLabel(e.to)} · {e.actor} · {pkt(e.at)}
                    {e.decision ? ` · decision #${String(e.decision)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <h2 style={{ marginBlockStart: 12 }}>Conflicts declared</h2>
          {c.conflicts.length === 0 ? (
            <p className="empty">None.</p>
          ) : (
            <ul className="checks">
              {c.conflicts.map((x) => (
                <li key={x.officer}>
                  <i className="no" aria-hidden="true">
                    !
                  </i>
                  <span className="small">
                    {x.officer} · {pkt(x.at)} · {x.note}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {decider && !c.me.conflicted ? (
            <details>
              <summary className="small">Declare a conflict on this case (you then decide nothing on it)</summary>
              <Decide
                officer={officer}
                c={c}
                kind="conflict"
                refId={c.id}
                digest={c.caseDigest}
                idSuffix="conflict"
                note="Recorded in the exit and admin audit chains."
                actions={[{ action: "declare", label: "Declare conflict", blockers: [], tone: "no" }]}
              />
            </details>
          ) : null}
        </section>

        <section className="card" aria-labelledby="decisions">
          <h2 id="decisions">Decisions ({c.decisions.length})</h2>
          {c.decisions.length === 0 ? <p className="empty">No decision yet.</p> : null}
          {c.decisions.map((d) => (
            <div key={d.id} className="stack" style={{ marginBlockEnd: 12 }} data-testid={`decision-${String(d.id)}`}>
              <b>
                #{d.id} {d.code} · {d.label} <span className={exitChip(d.status)}>{d.status}</span>
              </b>
              <span className="small mu">
                proposed by {d.proposedBy} · {pkt(d.proposedAt)} · {d.reason}
              </span>
              {Object.keys(d.detail).length > 0 ? (
                <span className="mono small">
                  {Object.entries(d.detail)
                    .map(([k, v]) => `${k}: ${detailValue(k, v)}`)
                    .join(" · ")}
                </span>
              ) : null}
              <ul className="checks">
                {d.capacities.map((cap) => {
                  const v = d.votes.find((x) => x.capacity === cap);
                  return (
                    <li key={cap}>
                      <i className={v ? (v.vote === "approve" ? "ok" : "no") : "wait"} aria-hidden="true">
                        {v ? (v.vote === "approve" ? "✓" : "✕") : "…"}
                      </i>
                      <span className="small">
                        <b>{exitCapacityLabel(cap)}</b> {v ? `${v.officer} · ${v.vote} · ${pkt(v.at)} · ${v.reason}` : "waiting"}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {d.problem ? <p className="alert bad small">Cannot take effect now: {d.problem}</p> : null}
              {d.status === "open" && decider ? (
                <Decide
                  officer={officer}
                  c={c}
                  kind="vote"
                  refId={d.id}
                  digest={d.digest}
                  idSuffix={`vote-${String(d.id)}`}
                  note={d.myCapacities.length > 0 ? `You vote as ${exitCapacityLabel(d.myCapacities[0] ?? "")}.` : "Bound to what you see."}
                  actions={[
                    { action: "approve", label: "Approve", blockers: [...voteBlockers(officer, c, d), ...(d.problem ? [d.problem] : [])], tone: "ok" },
                    { action: "reject", label: "Reject", blockers: voteBlockers(officer, c, d), tone: "no" },
                  ]}
                />
              ) : null}
            </div>
          ))}

          <h2 id="propose" style={{ marginBlockStart: 12 }}>
            Propose a decision
          </h2>
          {!maker ? (
            <p className="small mu">Operations makers propose decisions; the capacities listed decide them.</p>
          ) : openDecision ? (
            <p className="small mu">Decision #{openDecision.id} is open: it must be approved or rejected first.</p>
          ) : c.possibleDecisions.length === 0 ? (
            <p className="small mu">No decision is possible in this state.</p>
          ) : (
            <div className="stack">
              <form method="get" action={`/exit/${String(c.id)}`} className="row">
                <select name="propose" aria-label="Decision" defaultValue={proposeCode ?? ""} required>
                  <option value="" disabled>
                    Decision…
                  </option>
                  {c.possibleDecisions.map((p) => (
                    <option key={p.code} value={p.code}>
                      {p.code} · {p.label} ({p.capacities.map(exitCapacityLabel).join(" + ")})
                    </option>
                  ))}
                </select>
                <button className="btn" type="submit">
                  Choose
                </button>
              </form>
              {proposeCode ? (
                <StepUpForm csrf={officer.csrf} action={requestAction}>
                  <input type="hidden" name="action" value="propose" />
                  <input type="hidden" name="code" value={proposeCode} />
                  {fieldsOf(proposeCode).map((fd) => (
                    <DetailInput key={fd.key} f={fd} prefill={fd.kind === "wallet" ? prefillWallet : null} />
                  ))}
                  <textarea name="reason" required minLength={10} maxLength={500} placeholder="Reason (10 to 500 characters)" aria-label="Reason" />
                  <div className="row">
                    <button className="btn" type="submit" name="decision" value="propose">
                      Propose {proposeCode} with security key
                    </button>
                  </div>
                </StepUpForm>
              ) : null}
            </div>
          )}
        </section>
      </div>

      <div className="g2" style={{ marginBlockStart: 12 }}>
        <section className="card" aria-labelledby="proceeds">
          <h2 id="proceeds">Proceeds ({c.proceeds.length})</h2>
          <p className="di small">
            Approved {rupees(c.proceedsApproved)}
            {c.facts.salePricePaisa ? ` of the sale price ${rupees(String(c.facts.salePricePaisa))}` : ""}. Attributed from imported bank statement credit lines on the trustee escrow, once per line.
          </p>
          {c.proceeds.length > 0 ? (
            <div className="tbl-wrap">
              <table className="t" data-testid="proceeds">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Bank ref / date</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Status</th>
                    <th scope="col">Maker / checker</th>
                  </tr>
                </thead>
                <tbody>
                  {c.proceeds.map((p) => (
                    <tr key={p.id}>
                      <td className="mono">{p.id}</td>
                      <td>
                        {p.kind} {p.seq}
                      </td>
                      <td className="mono small">
                        {p.reference} · {p.valueDate} · {p.source}
                      </td>
                      <td className="mono">{rupees(p.amount)}</td>
                      <td>
                        <span className={exitChip(p.status)}>{p.status}</span>
                        {p.journal ? <span className="small mono"> j#{p.journal}</span> : null}
                      </td>
                      <td className="mono small">
                        {p.proposedBy} / {p.decidedBy ?? "–"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {decider
            ? c.proceeds
                .filter((p) => p.status === "proposed")
                .map((p) => (
                  <div key={p.id} className="stack">
                    <b className="small">
                      Proceeds #{p.id}: {rupees(p.amount)} ({p.note})
                    </b>
                    <Decide
                      officer={officer}
                      c={c}
                      kind="proceeds"
                      refId={p.id}
                      digest={p.digest}
                      idSuffix={`proceeds-${String(p.id)}`}
                      note="Operations checker; not the maker."
                      actions={[
                        { action: "approve", label: "Approve", blockers: [...checkerOnly, ...conflictNote], tone: "ok" },
                        { action: "reject", label: "Reject", blockers: [...checkerOnly, ...conflictNote], tone: "no" },
                      ]}
                    />
                  </div>
                ))
            : null}
          {maker ? (
            <StepUpForm csrf={officer.csrf} action={requestAction}>
              <input type="hidden" name="action" value="proceeds" />
              <div className="row">
                <select name="kind" aria-label="Kind" required defaultValue="">
                  <option value="" disabled>
                    Kind…
                  </option>
                  <option value="deposit">Deposit</option>
                  <option value="proceeds">Proceeds</option>
                </select>
                <input name="statementId" required inputMode="numeric" pattern="[1-9][0-9]*" placeholder="Bank statement #" aria-label="Statement" />
                <input name="lineNo" required inputMode="numeric" pattern="[1-9][0-9]*" placeholder="Line #" aria-label="Line" />
              </div>
              <input name="reason" required minLength={5} maxLength={300} placeholder="Note (5 to 300 characters)" aria-label="Note" />
              <div className="row">
                <button className="btn" type="submit" name="decision" value="proceeds">
                  Propose proceeds with security key
                </button>
              </div>
            </StepUpForm>
          ) : null}

          <h2 style={{ marginBlockStart: 12 }}>Record date</h2>
          {c.facts.recordDate ? (
            <p className="small">
              Record date <b className="mono">{String(c.facts.recordDate)}</b> announced {c.facts.recordAnnouncedAt ? pkt(String(c.facts.recordAnnouncedAt)) : ""} (notice{" "}
              {short(String(c.facts.recordNoticeSha ?? ""), 8)}).
            </p>
          ) : maker && (c.state === "completed_sale" || c.state === "waterfall") ? (
            <StepUpForm csrf={officer.csrf} action={requestAction}>
              <input type="hidden" name="action" value="announce" />
              <label className="small mu">
                Record date (at least the notice period ahead) <input type="date" name="recordDate" required aria-label="Record date" />
              </label>
              <input name="noticeSha" required pattern="[0-9a-fA-F]{64}" placeholder="SHA-256 of the record-date notice" aria-label="Notice SHA-256" />
              <div className="row">
                <button className="btn" type="submit" name="decision" value="announce">
                  Announce with security key
                </button>
              </div>
            </StepUpForm>
          ) : (
            <p className="empty">Not announced (after completion of the sale).</p>
          )}
        </section>

        <section className="card" aria-labelledby="waterfall">
          <h2 id="waterfall">
            Waterfall{" "}
            {w ? (
              <span className={exitChip(w.status)} data-testid="waterfall-status">
                v{w.version} {w.status}
              </span>
            ) : null}
          </h2>
          {w ? (
            <>
              <p className="di small">
                Inflows {rupees(w.inflows)} · outflows {rupees(w.outflows)} · drafted by {w.createdBy}
                {w.submittedBy ? ` · submitted by ${w.submittedBy}` : ""}
                {w.checkedBy ? ` · checked by ${w.checkedBy}` : ""}
                {w.approvedBy ? ` · approved by ${w.approvedBy}` : ""}
                {w.returnedBy ? ` · returned by ${w.returnedBy} (${w.returnReason ?? ""})` : ""}
              </p>
              {w.problem ? <p className="alert bad small">{w.problem}</p> : null}
              <div className="tbl-wrap">
                <table className="t" data-testid="waterfall-lines">
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">Kind / payee</th>
                      <th scope="col">Description</th>
                      <th scope="col">Amount</th>
                      <th scope="col">Evidence</th>
                      <th scope="col">Paid</th>
                      <th scope="col" />
                    </tr>
                  </thead>
                  <tbody>
                    {w.lines.map((l) => (
                      <tr key={l.id} className={l.withdrawn ? "mu" : undefined}>
                        <td className="mono">
                          {l.rank}.{l.id}
                        </td>
                        <td>
                          {l.kind}
                          {l.payee ? <span className="mono small"> · {l.payee}</span> : null}
                          {l.withdrawn ? <span className="chip"> withdrawn</span> : null}
                        </td>
                        <td className="small">{l.description}</td>
                        <td className="mono">{rupees(l.amount)}</td>
                        <td className="mono small">{short(l.evidence, 6)}</td>
                        <td className="mono small">
                          {rupees(l.paid)}
                          {l.payments.map((p) => (
                            <span key={p.id}>
                              {" "}
                              · #{p.id} {p.reference ?? ""} <span className={exitChip(p.status)}>{p.status}</span>
                            </span>
                          ))}
                        </td>
                        <td>
                          {maker && w.status === "draft" && !l.withdrawn ? (
                            <StepUpForm csrf={officer.csrf} action={requestAction}>
                              <input type="hidden" name="action" value="withdraw_line" />
                              <input type="hidden" name="lineId" value={String(l.id)} />
                              <button className="btn" type="submit" name="decision" value="withdraw">
                                Withdraw
                              </button>
                            </StepUpForm>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {maker && w.status === "draft" ? (
                <StepUpForm csrf={officer.csrf} action={requestAction}>
                  <input type="hidden" name="action" value="submit_waterfall" />
                  <div className="row">
                    <button className="btn" type="submit" name="decision" value="submit">
                      Submit the waterfall with security key
                    </button>
                    <span className="di small">An operations checker checks it, then a trustee officer approves it (three different people).</span>
                  </div>
                </StepUpForm>
              ) : null}
              {decider && (w.status === "submitted" || w.status === "checked") ? (
                <Decide
                  officer={officer}
                  c={c}
                  kind="waterfall"
                  refId={w.id}
                  digest={w.digest}
                  idSuffix="waterfall"
                  note={w.status === "submitted" ? "Operations checker checks." : "Trustee officer approves: all line journals post."}
                  actions={(() => {
                    const who = w.status === "submitted" ? checkerOnly : isTrustee ? [] : ["Only a trustee officer approves the checked waterfall."];
                    const b = [...who, ...conflictNote];
                    return [
                      { action: "approve", label: w.status === "submitted" ? "Check (approve)" : "Approve", blockers: [...b, ...(w.problem ? [w.problem] : [])], tone: "ok" as const },
                      { action: "reject", label: "Return", blockers: b, tone: "no" as const },
                    ];
                  })()}
                />
              ) : null}
            </>
          ) : (
            <p className="empty">No waterfall yet (from the Waterfall state on).</p>
          )}
          {maker && (!w || w.status === "draft" || w.status === "returned") && c.state === "waterfall" ? (
            <>
              <b className="small">Add a line</b>
              <StepUpForm csrf={officer.csrf} action={requestAction}>
                <input type="hidden" name="action" value="line" />
                <div className="row">
                  <select name="kind" aria-label="Line kind" required defaultValue="">
                    <option value="" disabled>
                      Kind…
                    </option>
                    {LINE_KINDS.map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <input name="payee" pattern="[a-z0-9][a-z0-9_\-]{1,39}" placeholder="Payee id (debts, costs, payables, deposits)" aria-label="Payee" />
                </div>
                <div className="row">
                  <input name="amount" required inputMode="decimal" placeholder="Amount (PKR)" aria-label="Amount (PKR)" />
                  <input name="evidenceSha" required pattern="[0-9a-fA-F]{64}" placeholder="SHA-256 of the evidence" aria-label="Evidence SHA-256" />
                </div>
                <input name="reason" required minLength={5} maxLength={300} placeholder="Description (5 to 300 characters)" aria-label="Description" />
                <div className="row">
                  <button className="btn" type="submit" name="decision" value="line">
                    Add line with security key
                  </button>
                </div>
              </StepUpForm>
            </>
          ) : null}

          {w && w.status === "approved" ? (
            <>
              <h2 style={{ marginBlockStart: 12 }}>Waterfall payments</h2>
              <p className="di small">A bank statement debit line on the trustee escrow pays exactly one booked outflow line (maker-checker).</p>
              {decider
                ? w.lines
                    .flatMap((l) => l.payments.filter((p) => p.status === "proposed").map((p) => ({ l, p })))
                    .map(({ l, p }) => (
                      <div key={p.id} className="stack">
                        <b className="small">
                          Payment #{p.id} of line {l.id} ({l.kind}
                          {l.payee ? ` · ${l.payee}` : ""}): {rupees(p.amount)} · {p.reference ?? ""}
                        </b>
                        <Decide
                          officer={officer}
                          c={c}
                          kind="payment"
                          refId={p.id}
                          digest={p.digest}
                          idSuffix={`payment-${String(p.id)}`}
                          note="Operations checker; not the maker."
                          actions={[
                            { action: "approve", label: "Approve", blockers: [...checkerOnly, ...conflictNote], tone: "ok" },
                            { action: "reject", label: "Reject", blockers: [...checkerOnly, ...conflictNote], tone: "no" },
                          ]}
                        />
                      </div>
                    ))
                : null}
              {maker && paidLines.length > 0 ? (
                <StepUpForm csrf={officer.csrf} action={requestAction}>
                  <input type="hidden" name="action" value="payment" />
                  <select name="lineId" aria-label="Waterfall line" required defaultValue="">
                    <option value="" disabled>
                      Outflow line…
                    </option>
                    {paidLines.map((l) => (
                      <option key={l.id} value={String(l.id)}>
                        #{l.id} {l.kind}
                        {l.payee ? ` · ${l.payee}` : ""} · {rupees(l.amount)} (paid {rupees(l.paid)})
                      </option>
                    ))}
                  </select>
                  <div className="row">
                    <input name="statementId" required inputMode="numeric" pattern="[1-9][0-9]*" placeholder="Bank statement #" aria-label="Statement" />
                    <input name="lineNo" required inputMode="numeric" pattern="[1-9][0-9]*" placeholder="Debit line #" aria-label="Line" />
                  </div>
                  <input name="reason" required minLength={5} maxLength={300} placeholder="Note (5 to 300 characters)" aria-label="Note" />
                  <div className="row">
                    <button className="btn" type="submit" name="decision" value="payment">
                      Propose payment with security key
                    </button>
                  </div>
                </StepUpForm>
              ) : null}
            </>
          ) : null}
        </section>
      </div>

      <div className="g2" style={{ marginBlockStart: 12 }}>
        <section className="card" aria-labelledby="final">
          <h2 id="final">
            Final distribution {f ? <span className={exitChip(f.status)} data-testid="final-status">{f.status}</span> : null}
          </h2>
          <p className="di small">
            Calculation, statement attachment and the redemption batch run in the exit service: <span className="mono">npm run exit:run -- calculate &lt;case&gt; &lt;block&gt;</span>,{" "}
            <span className="mono">attach &lt;final&gt;</span>, <span className="mono">redeem &lt;case&gt; [after_payment|after_finalization]</span>. The trustee pre-checks the
            root, then an operations checker decides; the Ops Safe publishes on chain.
          </p>
          {f ? (
            <>
              <dl className="kv">
                <dt>Record date / block</dt>
                <dd className="mono">
                  {f.recordDate} / {f.recordBlock}
                </dd>
                <dt>Income type</dt>
                <dd className="mono">{f.incomeType}</dd>
                <dt>Proceeds + inflows − outflows</dt>
                <dd className="mono small">
                  {rupees(f.proceeds)} + {rupees(f.inflows)} − {rupees(f.outflows)} = {rupees(f.distributableGross)}
                </dd>
                <dt>Withholding / net</dt>
                <dd className="mono">
                  {rupees(f.wht)} / {rupees(f.net)}
                </dd>
                <dt>Holders / units</dt>
                <dd className="mono">
                  {f.holders} / {f.units}
                </dd>
                <dt>Flagged / placeholder-rate lines</dt>
                <dd>
                  {f.flagged} / {f.placeholder > 0 ? <span className="chip bad">{f.placeholder} PLACEHOLDER</span> : "0"}
                </dd>
                <dt>Merkle root</dt>
                <dd className="mono small">{f.root ?? "– (not attached)"}</dd>
                <dt>Statement hash</dt>
                <dd className="mono small">{f.statementHash ?? "–"}</dd>
                <dt>Calculated / attached / decided</dt>
                <dd className="mono small">
                  {f.calculatedBy} / {f.attachedBy ?? "–"} / {f.decidedBy ?? "–"}
                </dd>
                <dt>Trustee pre-check</dt>
                <dd className="small">{f.precheck ? `${f.precheck.decision} by ${f.precheck.officer} · ${pkt(f.precheck.at)} · ${f.precheck.reason}` : "–"}</dd>
                <dt>On chain</dt>
                <dd className="mono small">{f.onchain ? `${short(f.onchain.registry, 6)} #${f.onchain.id} · ${f.onchain.status ?? "?"}` : "– (not published)"}</dd>
                {f.returnedReason ? (
                  <>
                    <dt>Returned</dt>
                    <dd>{f.returnedReason}</dd>
                  </>
                ) : null}
              </dl>
              {decider && f.status === "attached" && !f.precheck ? (
                <Decide
                  officer={officer}
                  c={c}
                  kind="precheck"
                  refId={f.id}
                  digest={f.digest}
                  idSuffix="precheck"
                  note="Trustee officer: recompute the root from the statement first."
                  extra={<input name="root" pattern="0x[0-9a-fA-F]{64}" placeholder="Merkle root you recomputed (0x…)" aria-label="Recomputed root" />}
                  actions={[
                    { action: "approve", label: "Pre-check: root matches", blockers: [...(isTrustee ? [] : ["Only a trustee officer pre-checks."]), ...conflictNote], tone: "ok" },
                    { action: "reject", label: "Refuse", blockers: [...(isTrustee ? [] : ["Only a trustee officer pre-checks."]), ...conflictNote], tone: "no" },
                  ]}
                />
              ) : null}
              {decider && (f.status === "calculated" || f.status === "attached") ? (
                <Decide
                  officer={officer}
                  c={c}
                  kind="final"
                  refId={f.id}
                  digest={f.digest}
                  idSuffix="final"
                  note="Operations checker; not the calculator or attacher."
                  actions={[
                    {
                      action: "approve",
                      label: "Approve",
                      blockers: [
                        ...checkerOnly,
                        ...(f.status !== "attached" ? ["The statement is not attached yet."] : []),
                        ...(f.precheck?.decision === "approve" ? [] : ["The trustee's pre-check (recomputed root) comes first (D4)."]),
                      ],
                      tone: "ok",
                    },
                    { action: "reject", label: "Return", blockers: checkerOnly, tone: "no" },
                  ]}
                />
              ) : null}
            </>
          ) : (
            <p className="empty">Not calculated yet.</p>
          )}
        </section>

        <section className="card" aria-labelledby="redemption">
          <h2 id="redemption">
            Redemption batch {r ? <span className={exitChip(r.status)} data-testid="redemption-status">{r.status}</span> : null}
          </h2>
          {r ? (
            <>
              <p className="di small">
                Burn rule <b>{r.burnRule}</b> · {r.lines} line(s) · {r.units} units · created by {r.createdBy}
                {r.checkedBy ? ` · checked by ${r.checkedBy}` : ""}
                {r.decidedBy ? ` · decided by ${r.decidedBy}` : ""} · items digest <span className="mono">{short(r.itemsDigest, 8)}</span>
              </p>
              <div className="tbl-wrap">
                <table className="t" data-testid="redemption-items">
                  <thead>
                    <tr>
                      <th scope="col">Wallet</th>
                      <th scope="col">Units</th>
                      <th scope="col">Net</th>
                      <th scope="col">Payment</th>
                      <th scope="col">Burn</th>
                      <th scope="col">refId</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.items.map((it) => (
                      <tr key={it.wallet}>
                        <td className="mono small">{short(it.wallet, 6)}</td>
                        <td className="mono">{it.units}</td>
                        <td className="mono">{rupees(it.net)}</td>
                        <td>
                          <span className={exitChip(it.payment)}>{it.payment}</span>
                          {it.released ? <span className="chip ok"> released</span> : null}
                          {maker && (it.payment === "held" || it.payment === "returned") && !it.released && r.status === "approved" && r.burnRule === "after_payment" ? (
                            <a className="small" href={`/exit/${String(c.id)}?propose=HR&wallet=${it.wallet}#propose`}>
                              {" "}
                              propose release (HR)
                            </a>
                          ) : null}
                        </td>
                        <td className="small">
                          {it.burned ? (
                            <span className="chip ok">burned at block {it.burned.block}</span>
                          ) : it.command ? (
                            <span className="mono">
                              {it.command.kind} · <span className={exitChip(it.command.status)}>{it.command.status}</span>
                              {it.command.lastError ? <span className="dn"> · {it.command.lastError}</span> : null}
                            </span>
                          ) : (
                            "–"
                          )}
                          {it.problem ? <span className="mu"> · {it.problem}</span> : null}
                        </td>
                        <td className="mono small">{short(it.refId, 6)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {decider && (r.status === "created" || r.status === "checked") ? (
                <Decide
                  officer={officer}
                  c={c}
                  kind="redemption"
                  refId={r.id}
                  digest={r.digest}
                  idSuffix="redemption"
                  note={r.status === "created" ? "Operations checker checks." : "Trustee officer approves: the final distribution is booked, the case moves to Redeeming, burns are enqueued."}
                  actions={(() => {
                    const who = r.status === "created" ? checkerOnly : isTrustee ? [] : ["Only a trustee officer approves the checked batch."];
                    const b = [...who, ...conflictNote];
                    return [
                      { action: "approve", label: r.status === "created" ? "Check (approve)" : "Approve", blockers: b, tone: "ok" as const },
                      { action: "reject", label: "Reject", blockers: b, tone: "no" as const },
                    ];
                  })()}
                />
              ) : null}
            </>
          ) : (
            <p className="empty">No redemption batch yet (created by the exit service after the final distribution is finalized).</p>
          )}
        </section>
      </div>
    </Shell>
  );
}

function FactRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="mono small">{k}</dt>
      <dd className="mono small">{v}</dd>
    </>
  );
}
