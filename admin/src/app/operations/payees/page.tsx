import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { StepUpForm } from "@/components/StepUp";
import { pkt } from "@/lib/format";
import { stateChip } from "@/lib/server/compliance";
import { bankPayeesConfigured, payeeDesk } from "@/lib/server/payees";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Payout accounts" };

/**
 * Assisted payout-account changes (migration 0055 AP-1..AP-4): an operations maker enters the
 * account for an investor who cannot do it on the website; a different operations checker approves
 * after calling the investor back. The IBAN goes straight to the bank service (sealed there); this
 * page shows only the last four digits and the bank code.
 */
export default async function PayeesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("operations.read", "/operations/payees");
  // Payout accounts are for operations makers and checkers only (the database refuses other operations readers).
  if (!officer.permissions.has("operations.request") && !officer.permissions.has("operations.decide")) notFound();
  const q = await searchParams;
  const desk = await payeeDesk(officer.sessionHash);

  return (
    <Shell officer={officer} current="/operations" title="Payout accounts (assisted)">
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="reqs">
          <h2 id="reqs">Assisted changes</h2>
          {desk.requests.length === 0 ? (
            <p className="empty">No assisted change yet.</p>
          ) : (
            <div className="tbl-wrap">
              <table className="t" data-testid="payee-requests">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Investor</th>
                    <th scope="col">Account</th>
                    <th scope="col">State</th>
                    <th scope="col">Entered by</th>
                    <th scope="col">Decided by</th>
                  </tr>
                </thead>
                <tbody>
                  {desk.requests.map((r) => (
                    <tr key={r.id}>
                      <td className="mono">
                        <a href={`/operations/payees/${String(r.id)}`}>#{r.id}</a>
                      </td>
                      <td className="mono">{r.ref}</td>
                      <td className="mono small">
                        {r.bankCode} ····{r.last4}
                      </td>
                      <td>
                        <span className={stateChip(r.status)}>{r.status}</span>
                      </td>
                      <td className="mono small">
                        {r.requestedBy} · {pkt(r.requestedAt)}
                      </td>
                      <td className="mono small">{r.decidedBy ? `${r.decidedBy} · ${pkt(r.decidedAt)}` : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        {desk.canRequest ? (
          <section className="card" aria-labelledby="enter">
            <h2 id="enter">Enter an account for an investor</h2>
            <p className="small mu">
              Only when the investor cannot change it on the website. The title must match the verified name; a different operations checker approves after calling the investor
              back on the number on file. The account is usable 72 hours after approval and the investor is told on every channel.
            </p>
            {bankPayeesConfigured() ? (
              <StepUpForm csrf={officer.csrf} action="/api/operations/payees">
                <input name="ref" required pattern="[0-9a-fA-F]{8}" placeholder="Support reference (8 characters)" aria-label="Investor reference" autoComplete="off" />
                <input name="iban" required placeholder="IBAN (PK…)" aria-label="IBAN" autoComplete="off" />
                <input name="title" required minLength={2} maxLength={140} placeholder="Account title as the bank holds it" aria-label="Account title" autoComplete="off" />
                <textarea name="reason" required minLength={10} maxLength={500} placeholder="How the investor asked (no CNIC, IBAN or phone number)" aria-label="Reason" />
                <div className="row">
                  <button className="btn" type="submit" name="decision" value="request">
                    Enter with security key
                  </button>
                </div>
              </StepUpForm>
            ) : (
              <p className="small dn" data-testid="bank-client-missing">
                The bank service client is not configured (BANK_CLIENT_SECRET_ADMIN): no assisted change can be entered.
              </p>
            )}
          </section>
        ) : null}
      </div>
    </Shell>
  );
}
