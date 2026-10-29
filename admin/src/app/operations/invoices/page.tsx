import type { Metadata } from "next";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { StepUpForm } from "@/components/StepUp";
import { pkt, short } from "@/lib/format";
import { config } from "@/lib/server/config";
import { rentInvoices, rupees } from "@/lib/server/operations";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Rent invoices" };

/**
 * Tenant rent invoices (migration 0044): a maker issues an invoice and hands the tenant a payment
 * link (shown once); when the bank statement shows the payment, the maker links the bank line (the
 * collection is proposed) and a different checker approves it, which marks the invoice paid.
 */
export default async function RentInvoicesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("operations.read", "/operations/invoices");
  const q = await searchParams;
  const { invoices, tokens } = await rentInvoices(officer.sessionHash);
  const maker = officer.permissions.has("operations.request");
  const checker = officer.permissions.has("operations.decide");
  const link = typeof q.link === "string" && /^[A-Za-z0-9_-]{43,64}$/.test(q.link) ? `${config.webPublicUrl}/pay/${q.link}` : null;
  return (
    <Shell officer={officer} current="/operations" title="Rent invoices">
      <Flash q={q} />
      {link ? (
        <p className="alert ok" role="status" data-testid="invoice-link">
          Payment link for the tenant (shown once, keep it with the invoice): <span className="mono">{link}</span>
        </p>
      ) : null}
      {maker ? (
        <section className="card" aria-labelledby="new" style={{ marginBlockEnd: 16 }}>
          <h2 id="new">Issue an invoice</h2>
          <StepUpForm csrf={officer.csrf} action="/api/operations/invoices">
            <div className="row">
              <label className="sr-only" htmlFor="token">
                Token
              </label>
              <select id="token" name="token" required>
                {tokens.map((t) => (
                  <option key={t} value={t}>
                    {short(t)}
                  </option>
                ))}
              </select>
              <label htmlFor="period">Period</label>
              <input id="period" name="period" placeholder="2026-11" pattern="\d{4}-\d{2}" required />
              <label htmlFor="due">Due</label>
              <input id="due" name="due" type="date" required />
            </div>
            <label htmlFor="tenant">Tenant or unit (no CNIC or phone numbers)</label>
            <input id="tenant" name="tenant" maxLength={80} required />
            <label htmlFor="rupees">Amount (PKR)</label>
            <input id="rupees" name="rupees" inputMode="decimal" required />
            <div className="row">
              <button className="btn" type="submit">
                Issue with security key
              </button>
            </div>
          </StepUpForm>
        </section>
      ) : null}
      <section className="card" aria-labelledby="list">
        <h2 id="list">Invoices</h2>
        {invoices.length === 0 ? <p className="empty">No invoice yet.</p> : null}
        <div className="stack" data-testid="invoices">
          {invoices.map((i) => (
            <article key={i.id} className="card" style={{ background: "rgba(255,255,255,.02)" }}>
              <div className="row">
                <b className="mono">{i.code}</b>
                <span className="sp" />
                <span className={`chip ${i.status === "paid" ? "ok" : i.overdue ? "bad" : ""}`}>{i.overdue ? "overdue" : i.status}</span>
              </div>
              <p className="small">
                {i.tenant} · {i.period} · {rupees(i.amount)} · due {i.due} · token {short(i.token)} · by {i.by}, {pkt(i.at)}
              </p>
              {i.status === "open" && maker ? (
                <StepUpForm csrf={officer.csrf} action={`/api/operations/invoices/${String(i.id)}/act`}>
                  {i.candidates && i.candidates.length > 0 ? (
                    <>
                      <label htmlFor={`line-${String(i.id)}`}>Bank line that paid it (same amount, last 60 days)</label>
                      <select id={`line-${String(i.id)}`} name="line">
                        {i.candidates.map((c) => (
                          <option key={`${String(c.statement)}:${String(c.line)}`} value={`${String(c.statement)}:${String(c.line)}`}>
                            {c.date} · {c.reference} · {c.counterparty}
                          </option>
                        ))}
                      </select>
                    </>
                  ) : (
                    <p className="small mu">No unused incoming bank line of this amount yet: import the statement first.</p>
                  )}
                  <div className="row">
                    {i.candidates && i.candidates.length > 0 ? (
                      <button className="btn" type="submit" name="action" value="record">
                        Record payment (a checker approves)
                      </button>
                    ) : null}
                    <button className="btn no" type="submit" name="action" value="cancel">
                      Cancel invoice
                    </button>
                  </div>
                </StepUpForm>
              ) : null}
              {i.status === "proposed" && i.collection ? (
                checker && i.collectionBy !== officer.handle ? (
                  <StepUpForm csrf={officer.csrf} action={`/api/operations/collections/${String(i.collection)}/decide`}>
                    <label className="sr-only" htmlFor={`cr-${String(i.id)}`}>
                      Reason for the decision
                    </label>
                    <textarea id={`cr-${String(i.id)}`} name="reason" required minLength={10} maxLength={500} placeholder="Reason (at least 10 characters)" />
                    <div className="row">
                      <button className="btn ok" type="submit" name="decision" value="approve">
                        Approve collection #{i.collection}
                      </button>
                      <button className="btn no" type="submit" name="decision" value="reject">
                        Reject
                      </button>
                    </div>
                  </StepUpForm>
                ) : (
                  <p className="small di">Collection #{i.collection} waits for an operations checker (not the one who proposed it).</p>
                )
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </Shell>
  );
}
