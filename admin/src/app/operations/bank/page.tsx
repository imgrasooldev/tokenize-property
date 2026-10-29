import type { Metadata } from "next";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { StepUpForm } from "@/components/StepUp";
import { pkt } from "@/lib/format";
import { bankDesk, bankStatements, rupees } from "@/lib/server/operations";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Bank statements" };

/**
 * Bank statements for reconciliation (migration 0037): the registered bank accounts, the latest
 * imported statements, and for operations makers the import of one statement file (mock format
 * pt-mock-bank-v1) with a security-key step-up. The database checks every rule of the file again.
 */
export default async function BankStatementsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("operations.read", "/operations/bank");
  const q = await searchParams;
  const [data, desk] = await Promise.all([bankStatements(officer.sessionHash), bankDesk(officer.sessionHash)]);
  const maker = officer.permissions.has("operations.request");
  const checker = officer.permissions.has("operations.decide");
  return (
    <Shell officer={officer} current="/operations" title="Bank statements">
      <Flash q={q} />
      {maker ? (
        <section className="card" aria-labelledby="imp" style={{ marginBlockEnd: 16 }} data-testid="bank-import">
          <h2 id="imp">Import a statement</h2>
          <p className="small mu">
            One file per bank account and day, in the bank&apos;s statement format (pt-mock-bank-v1 until the trustee bank&apos;s format is agreed). Importing the same file again
            changes nothing; a different file for a day already imported is refused.
          </p>
          <StepUpForm csrf={officer.csrf} action="/api/operations/bank" upload>
            <label htmlFor="statement">Statement file (.jsonl)</label>
            <input id="statement" name="statement" type="file" accept=".jsonl,.json,.txt,application/json" required />
            <div className="row">
              <button className="btn" type="submit">
                Import with security key
              </button>
            </div>
          </StepUpForm>
        </section>
      ) : null}
      <div className="g2" style={{ marginBlockEnd: 16 }}>
        <section className="card" aria-labelledby="susp" data-testid="suspense">
          <h2 id="susp">Credits in suspense</h2>
          <p className="small mu">Money that matched no payment code or came from an unregistered account. Returning it sends it back to the payer: a maker asks, a different checker decides.</p>
          {desk.suspense.length === 0 ? <p className="empty">Nothing in suspense.</p> : null}
          {desk.suspense.map((c) => (
            <article key={c.ref} className="card" style={{ background: "rgba(255,255,255,.02)" }}>
              <b className="mono small">{c.ref}</b>
              <p className="small">
                {rupees(c.amount)} · {c.valueDate} · payer account …{c.payerLast4}
              </p>
              {maker && !desk.returns.some((r) => r.ref === c.ref) ? (
                <StepUpForm csrf={officer.csrf} action="/api/operations/bank/returns">
                  <input type="hidden" name="ref" value={c.ref} />
                  <label className="sr-only" htmlFor={`rr-${c.ref}`}>
                    Why return it
                  </label>
                  <textarea id={`rr-${c.ref}`} name="reason" required minLength={10} maxLength={300} placeholder="Why it goes back (at least 10 characters)" />
                  <div className="row">
                    <button className="btn" type="submit">
                      Ask to return to the payer
                    </button>
                  </div>
                </StepUpForm>
              ) : null}
            </article>
          ))}
          {desk.returns.map((r) => (
            <article key={r.id} className="card" style={{ background: "rgba(255,255,255,.02)" }} data-testid={`return-${String(r.id)}`}>
              <b>
                #{r.id} Return <span className="mono">{r.ref}</span>
              </b>
              <p className="small mu">
                Asked by <span className="mono">{r.requestedBy}</span> at {pkt(r.requestedAt)}: {r.reason}
              </p>
              {checker && r.requestedBy !== officer.handle ? (
                <StepUpForm csrf={officer.csrf} action={`/api/operations/bank/returns/${String(r.id)}/decide`}>
                  <label className="sr-only" htmlFor={`rd-${String(r.id)}`}>
                    Reason for the decision
                  </label>
                  <textarea id={`rd-${String(r.id)}`} name="reason" required minLength={10} maxLength={500} placeholder="Reason (at least 10 characters)" />
                  <div className="row">
                    <button className="btn ok" type="submit" name="decision" value="approve">
                      Approve with security key
                    </button>
                    <button className="btn no" type="submit" name="decision" value="reject">
                      Reject
                    </button>
                  </div>
                </StepUpForm>
              ) : (
                <p className="small di">{r.requestedBy === officer.handle ? "Your request: a different checker decides it." : "Waiting for an operations checker."}</p>
              )}
            </article>
          ))}
        </section>
        <section className="card" aria-labelledby="held" data-testid="held-payouts">
          <h2 id="held">Held payouts</h2>
          <p className="small mu">Shares held back because the investor had no active payout account. A follow-up batch pays those who have one now; a checker approves it in Approvals.</p>
          {desk.held.length === 0 ? <p className="empty">No submitted batch has held lines.</p> : null}
          {desk.held.map((b) => (
            <article key={b.batch} className="card" style={{ background: "rgba(255,255,255,.02)" }}>
              <b className="mono small">{b.reference}</b>
              <p className="small">
                Distribution {b.distribution} · {b.heldLines} held · {b.payableNow} payable now
              </p>
              {maker && b.payableNow > 0 ? (
                <StepUpForm csrf={officer.csrf} action="/api/operations/bank/followup">
                  <input type="hidden" name="parent" value={b.batch} />
                  <div className="row">
                    <button className="btn" type="submit">
                      Create follow-up batch ({b.payableNow})
                    </button>
                  </div>
                </StepUpForm>
              ) : null}
            </article>
          ))}
        </section>
      </div>
      <div className="g2">
        <section className="card" aria-labelledby="acc">
          <h2 id="acc">Registered bank accounts</h2>
          {data.accounts.length === 0 ? (
            <p className="empty">No bank account is registered for reconciliation.</p>
          ) : (
            <ul className="small mono">
              {data.accounts.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          )}
        </section>
        <section className="card" aria-labelledby="st">
          <h2 id="st">Latest statements</h2>
          {data.statements.length === 0 ? (
            <p className="empty">No statement imported yet.</p>
          ) : (
            <div className="tbl-wrap">
              <table className="t" data-testid="bank-statements">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Account / day</th>
                    <th scope="col" className="n">
                      Opening
                    </th>
                    <th scope="col" className="n">
                      Closing
                    </th>
                    <th scope="col">Imported</th>
                  </tr>
                </thead>
                <tbody>
                  {data.statements.map((s) => (
                    <tr key={s.id}>
                      <td className="mono">{s.id}</td>
                      <td className="mono small">
                        {s.account} · {s.date}
                      </td>
                      <td className="n mono">{rupees(s.opening)}</td>
                      <td className="n mono">{rupees(s.closing)}</td>
                      <td className="small">
                        {s.by} · {pkt(s.at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </Shell>
  );
}
