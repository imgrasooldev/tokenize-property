import type { Metadata } from "next";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { StepUpForm } from "@/components/StepUp";
import { pkt, short } from "@/lib/format";
import { exitChip, exitStateLabel } from "@/lib/exit";
import { exitOverview } from "@/lib/server/exit";
import { rupees } from "@/lib/server/operations";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Exit" };

/**
 * S-05 (migration 0027): exit cases (sale of the property, waterfall, final distribution,
 * redemption and closure) and investor redemption windows. Operations makers open and prepare;
 * operations checkers, compliance, legal and trustee officers decide in their capacity; auditors
 * read. Everything is enforced by the database; this page lists and explains.
 */
export default async function ExitPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("exit.read", "/exit");
  const q = await searchParams;
  const o = await exitOverview(officer.sessionHash);
  const maker = officer.permissions.has("exit.request");
  const settings = Object.entries(o.settings ?? {}).sort(([a], [b]) => a.localeCompare(b));

  return (
    <Shell officer={officer} current="/exit" title="Exit">
      <Flash q={q} />
      <nav className="tabs" aria-label="Exit">
        <a href="/exit" aria-current="page">
          Cases and windows
        </a>
        <a href="/audit/exit">Audit trail</a>
      </nav>
      <div className="g2">
        <section className="card" aria-labelledby="cases">
          <h2 id="cases">Exit cases ({o.cases.length})</h2>
          {o.cases.length === 0 ? (
            <p className="empty">No exit case.</p>
          ) : (
            <div className="tbl-wrap">
              <table className="t" data-testid="exit-cases">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Token</th>
                    <th scope="col">State</th>
                    <th scope="col">Offer / sale price</th>
                    <th scope="col">Record date</th>
                    <th scope="col">Open decision</th>
                    <th scope="col">Opened</th>
                  </tr>
                </thead>
                <tbody>
                  {o.cases.map((c) => (
                    <tr key={c.id}>
                      <td className="mono">
                        <a href={`/exit/${String(c.id)}`}>#{c.id}</a>
                      </td>
                      <td className="mono small">{short(c.token, 6)}</td>
                      <td>
                        <span className={exitChip(c.state)}>{exitStateLabel(c.state)}</span>
                      </td>
                      <td className="mono small">
                        {rupees(c.offerPaisa)}
                        {c.salePricePaisa ? ` / ${rupees(c.salePricePaisa)}` : ""}
                      </td>
                      <td className="mono small">{c.recordDate ?? "–"}</td>
                      <td className="small">{c.openDecision ? `${c.openDecision.code} · ${String(c.openDecision.votes)}/${String(c.openDecision.needed)} votes` : "–"}</td>
                      <td className="mono small">
                        {c.openedBy} · {pkt(c.openedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h2 style={{ marginBlockStart: 12 }}>Redemption windows ({o.windows.length})</h2>
          <p className="di small">Phase 0: a request queue only (non-binding interest, no money or units move). Indicative price = NAV × (1 − discount).</p>
          {o.windows.length === 0 ? (
            <p className="empty">No redemption window.</p>
          ) : (
            <div className="tbl-wrap">
              <table className="t" data-testid="exit-windows">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Token</th>
                    <th scope="col">Status</th>
                    <th scope="col">Opens – closes</th>
                    <th scope="col">Price / unit</th>
                    <th scope="col">Requested / cap</th>
                    <th scope="col">Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {o.windows.map((w) => (
                    <tr key={w.id}>
                      <td className="mono">
                        <a href={`/exit/windows/${String(w.id)}`}>#{w.id}</a>
                      </td>
                      <td className="mono small">{short(w.token, 6)}</td>
                      <td>
                        <span className={exitChip(w.status)}>{w.status}</span> {w.open ? <span className="chip ok">open now</span> : null}
                      </td>
                      <td className="mono small">
                        {pkt(w.opensAt)} – {pkt(w.closesAt)}
                      </td>
                      <td className="mono small">{rupees(w.pricePerUnitPaisa)}</td>
                      <td className="mono small">
                        {w.requested} / {w.capUnits ?? "–"} ({w.requests} request{w.requests === 1 ? "" : "s"})
                      </td>
                      <td>
                        <span className={exitChip(w.outcome)}>{w.outcome}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h2 style={{ marginBlockStart: 12 }}>Tokens</h2>
          <div className="tbl-wrap">
            <table className="t" data-testid="exit-tokens">
              <thead>
                <tr>
                  <th scope="col">Token</th>
                  <th scope="col">Supply</th>
                  <th scope="col">Trustee cap</th>
                  <th scope="col">Paused</th>
                  <th scope="col">Exit under way</th>
                </tr>
              </thead>
              <tbody>
                {o.tokens.map((t) => (
                  <tr key={t.token}>
                    <td className="mono small">{t.token}</td>
                    <td className="mono">{t.supply}</td>
                    <td className="mono">{t.cap ?? "–"}</td>
                    <td>{t.paused === null ? "–" : t.paused ? "yes" : "no"}</td>
                    <td>{t.exitUnderway ? <span className="chip warn">yes</span> : "no"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="di small" style={{ marginBlockStart: 8 }}>
            Burn signing policy (issuance.burn): {o.burnPolicy ? <span className="chip ok">active</span> : <span className="chip bad">missing</span>}. Settings:{" "}
            <span className="mono">{settings.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" · ") || "–"}</span>
          </p>
        </section>

        <section className="card" aria-labelledby="open">
          <h2 id="open">Open an exit case</h2>
          <p className="di small">
            The offer, two different independent valuations (amounts in PKR and the SHA-256 of each report), the estimated costs and whether the unit rights require an investor vote. An
            investment committee decision (operations checker + compliance officer) follows.
          </p>
          {maker ? (
            <div className="stack">
              <StepUpForm csrf={officer.csrf} action="/api/exit/cases">
                <select name="token" aria-label="Token" required defaultValue="">
                  <option value="" disabled>
                    Token…
                  </option>
                  {o.tokens
                    .filter((t) => !t.exitUnderway)
                    .map((t) => (
                      <option key={t.token} value={t.token}>
                        {t.token}
                      </option>
                    ))}
                </select>
                <input name="offer" required inputMode="decimal" placeholder="Offer (PKR)" aria-label="Offer (PKR)" />
                <div className="row">
                  <input name="valuationA" required inputMode="decimal" placeholder="Valuation A (PKR)" aria-label="Valuation A (PKR)" />
                  <input name="valuationASha" required pattern="[0-9a-fA-F]{64}" placeholder="SHA-256 of valuation A" aria-label="Valuation A SHA-256" />
                </div>
                <div className="row">
                  <input name="valuationB" required inputMode="decimal" placeholder="Valuation B (PKR)" aria-label="Valuation B (PKR)" />
                  <input name="valuationBSha" required pattern="[0-9a-fA-F]{64}" placeholder="SHA-256 of valuation B" aria-label="Valuation B SHA-256" />
                </div>
                <input name="costs" required inputMode="decimal" placeholder="Estimated costs (PKR, may be 0)" aria-label="Estimated costs (PKR)" />
                <select name="voteRequired" aria-label="Investor vote" required defaultValue="">
                  <option value="" disabled>
                    Do the unit rights require an investor vote?
                  </option>
                  <option value="true">Yes: an investor vote (X2)</option>
                  <option value="false">No: committee recommendation only (X3)</option>
                </select>
                <textarea name="rationale" required minLength={20} maxLength={2000} placeholder="Rationale (at least 20 characters; no CNIC, IBAN or phone number)" aria-label="Rationale" />
                <div className="row">
                  <button className="btn" type="submit" name="decision" value="open">
                    Open with security key
                  </button>
                </div>
              </StepUpForm>

              <h2 style={{ marginBlockStart: 12 }}>Propose a redemption window</h2>
              <p className="di small">Times in Pakistan time (PKT). Refused while an exit of the token is under way (from the investor vote on). An operations checker approves it and fixes the cap.</p>
              <StepUpForm csrf={officer.csrf} action="/api/exit/windows">
                <input type="hidden" name="action" value="window" />
                <select name="token" aria-label="Window token" required defaultValue="">
                  <option value="" disabled>
                    Token…
                  </option>
                  {o.tokens
                    .filter((t) => !t.exitUnderway)
                    .map((t) => (
                      <option key={t.token} value={t.token}>
                        {t.token}
                      </option>
                    ))}
                </select>
                <div className="row">
                  <label className="small mu">
                    Opens <input type="datetime-local" name="opensAt" required aria-label="Opens (PKT)" />
                  </label>
                  <label className="small mu">
                    Closes <input type="datetime-local" name="closesAt" required aria-label="Closes (PKT)" />
                  </label>
                </div>
                <div className="row">
                  <input name="nav" required inputMode="decimal" placeholder="NAV per unit (PKR)" aria-label="NAV per unit (PKR)" />
                  <input name="discountPpm" inputMode="numeric" pattern="[0-9]{1,7}" defaultValue="0" placeholder="Discount (ppm)" aria-label="Discount (ppm)" />
                </div>
                <input name="navSha" required pattern="[0-9a-fA-F]{64}" placeholder="SHA-256 of the NAV valuation evidence" aria-label="NAV evidence SHA-256" />
                <textarea name="reason" required minLength={10} maxLength={300} placeholder="Note (10 to 300 characters)" aria-label="Note" />
                <div className="row">
                  <button className="btn" type="submit" name="decision" value="window">
                    Propose with security key
                  </button>
                </div>
              </StepUpForm>

              <form method="post" action="/api/exit/sync" className="row" style={{ marginBlockStart: 10 }}>
                <input type="hidden" name="csrf" value={officer.csrf} />
                <button className="btn" type="submit" name="decision" value="sync">
                  Refresh from chain
                </button>
                <span className="di small">Follows publication, finalization, burns and the payout on chain (also run by exit:tick).</span>
              </form>
            </div>
          ) : (
            <p className="small mu">Operations makers open cases and propose windows; your role reads{officer.permissions.has("exit.decide") ? " and decides them" : " them"}.</p>
          )}
        </section>
      </div>
    </Shell>
  );
}
