import type { Metadata } from "next";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { StepUpForm } from "@/components/StepUp";
import { TrusteeTabs } from "@/components/TrusteeTabs";
import { int, pkt, short } from "@/lib/format";
import { stateChip } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";
import { ADDRESS, registerView, trusteeDashboard, units } from "@/lib/server/trustee";

export const metadata: Metadata = { title: "Trustee register" };

const LIMIT = 500;

/**
 * The trustee's register next to the holders in the chain read model, both pinned to the indexer's
 * cursor block (one database snapshot), with supply against the trustee cap. Differences come
 * first and are highlighted. Exports are recorded with their SHA-256 before release; adjustments
 * (opening balances, corrections) need evidence and a second trustee officer.
 */
export default async function RegisterPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("trustee.read", "/trustee/register");
  const q = await searchParams;
  const d = await trusteeDashboard(officer.sessionHash);
  const asked = typeof q.token === "string" ? q.token.toLowerCase() : null;
  const token = asked && ADDRESS.test(asked) ? asked : (d.tokens[0]?.token ?? null);
  const r = token ? await registerView(officer.sessionHash, token, LIMIT) : null;
  const canDecide = officer.permissions.has("trustee.decide");
  const canExport = officer.permissions.has("trustee.export");
  const supplyVsRegister = r ? BigInt(r.supply) - BigInt(r.registerTotal) : 0n;

  return (
    <Shell officer={officer} current="/trustee/register" title="Trustee register">
      <TrusteeTabs current="/trustee/register" />
      <Flash q={q} />
      {d.tokens.length > 1 ? (
        <nav className="tabs" aria-label="Tokens">
          {d.tokens.map((t) => (
            <a key={t.token} href={`/trustee/register?token=${t.token}`} aria-current={t.token === token ? "page" : undefined}>
              {t.deployment}
            </a>
          ))}
        </nav>
      ) : null}
      {!r ? (
        <p className="empty">No token in the read model yet.</p>
      ) : (
        <>
          <div className="kpis" data-testid="register-kpis">
            <div className="kpi">
              <div className="label">Supply (chain)</div>
              <div className="val">{units(r.supply)}</div>
              <div className="sub">read model, token updated at block #{r.tokenUpdatedBlock}</div>
            </div>
            <div className="kpi">
              <div className="label">Trustee cap</div>
              <div className={`val ${BigInt(r.supply) > BigInt(r.cap) ? "dn" : ""}`}>{units(r.cap)}</div>
              <div className="sub">{BigInt(r.supply) > BigInt(r.cap) ? "SUPPLY ABOVE CAP" : `headroom ${units((BigInt(r.cap) - BigInt(r.supply)).toString())}`}</div>
            </div>
            <div className="kpi">
              <div className="label">Trustee register</div>
              <div className={`val ${supplyVsRegister === 0n ? "up" : "dn"}`} data-testid="register-total">
                {units(r.registerTotal)}
              </div>
              <div className="sub">{supplyVsRegister === 0n ? "equals supply" : `supply − register = ${units(supplyVsRegister.toString())}`}</div>
            </div>
            <div className="kpi">
              <div className="label">Wallet differences</div>
              <div className={`val ${r.differences === 0 ? "up" : "dn"}`} data-testid="register-differences">
                {int(r.differences)}
              </div>
              <div className="sub">
                {int(r.chainHolders)} holders on chain · {int(r.lineCount)} lines
              </div>
            </div>
            <div className="kpi">
              <div className="label">Pinned to block</div>
              <div className="val mono" data-testid="pinned-block">
                #{r.pinned?.block ?? "–"}
              </div>
              <div className="sub mono">
                {short(r.pinned?.hash ?? null)} · {pkt(r.pinned?.updatedAt)}
                {r.pinned?.halted ? <span className="chip bad">indexer halted</span> : null}
              </div>
            </div>
            <div className="kpi">
              <div className="label">Trustee attestation (S-02 L14)</div>
              <div className="val">{r.attestation ? units(String(r.attestation.totalUnits)) : "–"}</div>
              <div className="sub mono">{r.attestation ? `${short(r.attestation.registerSha)} · ${pkt(r.attestation.at)}` : "no completed offering"}</div>
            </div>
          </div>

          <section className="card" aria-labelledby="lines">
            <h2 id="lines">
              Holders: register next to chain <span className="sp" />
              {canExport ? (
                <form method="post" action="/api/trustee/register/export" className="row">
                  <input type="hidden" name="csrf" value={officer.csrf} />
                  <input type="hidden" name="token" value={r.token} />
                  <button className="btn" type="submit" name="decision" value="export">
                    Export with SHA-256 evidence
                  </button>
                </form>
              ) : null}
            </h2>
            {r.lines.length === 0 ? (
              <p className="empty">Neither the register nor the chain holds units of this token.</p>
            ) : (
              <div className="tbl-wrap">
                <table className="t" data-testid="register-lines">
                  <thead>
                    <tr>
                      <th scope="col">Wallet</th>
                      <th scope="col" className="n">
                        Register
                      </th>
                      <th scope="col" className="n">
                        Chain (read model)
                      </th>
                      <th scope="col" className="n">
                        Chain − register
                      </th>
                      <th scope="col">State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.lines.map((l) => {
                      const differs = l.difference !== "0";
                      return (
                        <tr key={l.wallet} className={differs ? "diff-row" : undefined} data-differs={differs ? "yes" : "no"}>
                          <td className="mono small">{l.wallet}</td>
                          <td className="n mono">{units(l.register)}</td>
                          <td className="n mono">{units(l.chain)}</td>
                          <td className={`n mono ${differs ? "dn" : ""}`}>{units(l.difference)}</td>
                          <td>{differs ? <span className="chip bad">differs</span> : <span className="chip ok">matches</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {r.lineCount > r.lines.length ? (
              <p className="small mu">
                Showing the first {int(r.lines.length)} of {int(r.lineCount)} lines (differences first); the export holds all of them.
              </p>
            ) : null}
          </section>

          <div className="g2">
            <section className="card" aria-labelledby="adj">
              <h2 id="adj">Register adjustments</h2>
              {r.adjustments.length === 0 ? (
                <p className="empty">No adjustment for this token.</p>
              ) : (
                <div className="tbl-wrap">
                  <table className="t" data-testid="adjustments">
                    <thead>
                      <tr>
                        <th scope="col">#</th>
                        <th scope="col">Wallet</th>
                        <th scope="col" className="n">
                          Units
                        </th>
                        <th scope="col">State</th>
                        <th scope="col">Proposed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.adjustments.map((a) => (
                        <tr key={a.id}>
                          <td className="mono">
                            <a href={`/trustee/register/adjustments/${String(a.id)}`}>#{a.id}</a>
                          </td>
                          <td className="mono small">{short(a.wallet)}</td>
                          <td className="n mono">{units(a.units)}</td>
                          <td>
                            <span className={stateChip(a.status)}>{a.status}</span>
                          </td>
                          <td className="small">
                            <span className="mono">{a.proposedBy}</span> · {pkt(a.proposedAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            {canDecide ? (
              <section className="card" aria-labelledby="propose">
                <h2 id="propose">Propose an adjustment</h2>
                <p className="small mu">
                  For an opening balance or a correction of the trustee&apos;s own register. A different trustee officer decides within 72 hours; no balance can go
                  below zero. The chain is never changed from here.
                </p>
                <StepUpForm csrf={officer.csrf} action="/api/trustee/register/adjustments">
                  <input type="hidden" name="token" value={r.token} />
                  <input name="wallet" required pattern="0x[0-9a-fA-F]{40}" placeholder="Wallet (0x…)" aria-label="Wallet" />
                  <input name="units" required pattern="-?[1-9][0-9]{0,12}" placeholder="Units (+ adds, − removes)" aria-label="Units" />
                  <input name="evidence" required pattern="[0-9a-fA-F]{64}" placeholder="SHA-256 of the evidence (register extract, deed)" aria-label="Evidence SHA-256" />
                  <textarea name="reason" required minLength={10} maxLength={500} placeholder="Reason (no CNIC, IBAN or phone number)" aria-label="Reason" />
                  <button className="btn" type="submit" name="decision" value="propose">
                    Propose with security key
                  </button>
                </StepUpForm>
              </section>
            ) : null}
          </div>
        </>
      )}
    </Shell>
  );
}
