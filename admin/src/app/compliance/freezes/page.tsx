import type { Metadata } from "next";
import { ComplianceTabs } from "@/components/ComplianceTabs";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { StepUpForm } from "@/components/StepUp";
import { pkt, short } from "@/lib/format";
import { freezeList, partialFreezeList, stateChip } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Freezes" };

/**
 * Freeze and unfreeze requests (Step 6c, migration 0019 C-3): one compliance officer proposes with a
 * reason code, a different one decides; an approval puts the command in the outbox for the signing
 * service (existing compliance.freeze policy, new compliance.unfreeze policy). Partial freezes
 * (migration 0054) hold an amount of one token on the same two-officer path and leave the KYC
 * status unchanged.
 */
export default async function FreezesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("compliance.read", "/compliance/freezes");
  const q = await searchParams;
  const [f, pf] = await Promise.all([freezeList(officer.sessionHash), partialFreezeList(officer.sessionHash)]);
  const units = (n: string) => Number(n).toLocaleString("en-PK");
  const canDecide = officer.permissions.has("compliance.decide");
  const codes = (kind: string) => f.reasonCodes.filter((r) => r.appliesTo === kind);

  return (
    <Shell officer={officer} current="/compliance/freezes" title="Freezes">
      <ComplianceTabs current="/compliance/freezes" />
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="reqs">
          <h2 id="reqs">Requests</h2>
          {f.requests.length === 0 ? (
            <p className="empty">No freeze or unfreeze request yet.</p>
          ) : (
            <div className="tbl-wrap">
              <table className="t" data-testid="freeze-requests">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Wallet</th>
                    <th scope="col">Reason code</th>
                    <th scope="col">State</th>
                    <th scope="col">Proposed by</th>
                    <th scope="col">Command</th>
                  </tr>
                </thead>
                <tbody>
                  {f.requests.map((r) => (
                    <tr key={r.id}>
                      <td className="mono">
                        <a href={`/compliance/freezes/${String(r.id)}`}>#{r.id}</a>
                      </td>
                      <td>{r.kind}</td>
                      <td className="mono small">{short(r.wallet, 6)}</td>
                      <td className="mono small">{r.reasonCode}</td>
                      <td>
                        <span className={stateChip(r.status)}>{r.status}</span>
                      </td>
                      <td className="mono small">
                        {r.requestedBy} · {pkt(r.requestedAt)}
                      </td>
                      <td>{r.command ? <span className={stateChip(r.command.status)}>{r.command.status}</span> : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card" aria-labelledby="holds">
          <h2 id="holds">Wallets held ({f.holds.length})</h2>
          {f.holds.length === 0 ? (
            <p className="empty">No active compliance hold.</p>
          ) : (
            <ul className="checks" data-testid="holds">
              {f.holds.map((h) => (
                <li key={h.id}>
                  <i className="no" aria-hidden="true">
                    ⏸
                  </i>
                  <span className="mono small">
                    {short(h.wallet, 6)} · investor {h.subject} · <a href={`/compliance/freezes/${String(h.freezeRequest)}`}>freeze #{h.freezeRequest}</a> · {pkt(h.placedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="di small" style={{ marginBlockStart: 8 }}>
            Signing policies: freeze {f.policies.freeze ? "active" : "missing"} · unfreeze {f.policies.unfreeze ? "active" : "missing"}. A held investor reads
            &quot;suspended&quot;: no gate treats them as verified until a second officer approves the unfreeze.
          </p>
          {canDecide ? (
            <div className="stack" style={{ marginBlockStart: 10 }}>
              <b className="small">Propose a freeze or unfreeze (a different officer decides)</b>
              <StepUpForm csrf={officer.csrf} action="/api/compliance/freezes">
                <select name="kind" aria-label="Kind" defaultValue="freeze">
                  <option value="freeze">freeze</option>
                  <option value="unfreeze">unfreeze</option>
                </select>
                <input name="wallet" required pattern="0x[0-9a-fA-F]{40}" placeholder="Investor wallet 0x…" aria-label="Wallet" />
                <select name="reasonCode" aria-label="Reason code" required defaultValue="">
                  <option value="" disabled>
                    Reason code…
                  </option>
                  <optgroup label="Freeze">
                    {codes("freeze").map((c) => (
                      <option key={`f-${c.code}`} value={c.code}>
                        {c.label}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Unfreeze">
                    {codes("unfreeze").map((c) => (
                      <option key={`u-${c.code}`} value={c.code}>
                        {c.label}
                      </option>
                    ))}
                  </optgroup>
                </select>
                <input name="kycCase" inputMode="numeric" pattern="[1-9][0-9]*" placeholder="KYC case # (optional)" aria-label="KYC case" />
                <input name="strCase" inputMode="numeric" pattern="[1-9][0-9]*" placeholder="STR case # (optional)" aria-label="STR case" />
                <textarea name="reason" required minLength={10} maxLength={500} placeholder="Reason (no CNIC, IBAN or phone number)" aria-label="Reason" />
                <div className="row">
                  <button className="btn" type="submit" name="decision" value="request">
                    Propose with security key
                  </button>
                </div>
              </StepUpForm>
            </div>
          ) : null}
        </section>
      </div>

      <section className="card" aria-labelledby="partial" style={{ marginBlockStart: 16 }}>
        <h2 id="partial">Partial freezes (an amount of the token)</h2>
        <p className="di small">
          Token {pf.token ? <span className="mono">{short(pf.token, 6)}</span> : "–"} · signing policies: partial freeze {pf.policies.freeze ? "active" : "missing"} · release{" "}
          {pf.policies.unfreeze ? "active" : "missing"}. The investor stays verified and keeps the rest of the balance; a release lifts one whole partial hold once it is on chain.
        </p>
        <div className="g2">
          <div>
            <b className="small">Requests</b>
            {pf.requests.length === 0 ? (
              <p className="empty">No partial freeze request yet.</p>
            ) : (
              <div className="tbl-wrap">
                <table className="t" data-testid="partial-requests">
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">Kind</th>
                      <th scope="col">Wallet</th>
                      <th scope="col">Units</th>
                      <th scope="col">State</th>
                      <th scope="col">Proposed by</th>
                      <th scope="col">Command</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pf.requests.map((r) => (
                      <tr key={r.id}>
                        <td className="mono">
                          <a href={`/compliance/partial-freezes/${String(r.id)}`}>#{r.id}</a>
                        </td>
                        <td>{r.kind === "freeze" ? "freeze" : "release"}</td>
                        <td className="mono small">{short(r.wallet, 6)}</td>
                        <td>{units(r.amount)}</td>
                        <td>
                          <span className={stateChip(r.status)}>{r.status}</span>
                        </td>
                        <td className="mono small">
                          {r.requestedBy} · {pkt(r.requestedAt)}
                        </td>
                        <td>{r.command ? <span className={stateChip(r.command.status)}>{r.command.status}</span> : "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <b className="small" style={{ display: "block", marginBlockStart: 10 }}>
              Partial holds ({pf.holds.length})
            </b>
            {pf.holds.length === 0 ? (
              <p className="empty">No active partial hold.</p>
            ) : (
              <ul className="checks" data-testid="partial-holds">
                {pf.holds.map((h) => (
                  <li key={h.id}>
                    <i className="no" aria-hidden="true">
                      ⏸
                    </i>
                    <span className="mono small">
                      {units(h.amount)} units · {short(h.wallet, 6)} · investor {h.subject} · <a href={`/compliance/partial-freezes/${String(h.freezeRequest)}`}>partial freeze #{h.freezeRequest}</a> ·{" "}
                      {h.onChain ? "on chain" : "not on chain yet"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {canDecide ? (
            <div className="stack">
              <b className="small">Propose a partial freeze or a release (a different officer decides)</b>
              <StepUpForm csrf={officer.csrf} action="/api/compliance/partial-freezes">
                <select name="kind" aria-label="Partial kind" defaultValue="freeze">
                  <option value="freeze">freeze an amount</option>
                  <option value="unfreeze">release a partial hold</option>
                </select>
                <input name="wallet" required pattern="0x[0-9a-fA-F]{40}" placeholder="Investor wallet 0x…" aria-label="Partial wallet" />
                <input name="amount" inputMode="numeric" pattern="[1-9][0-9]*" placeholder="Units to freeze (freeze only)" aria-label="Units" />
                <input name="lifts" inputMode="numeric" pattern="[1-9][0-9]*" placeholder="Partial freeze # to release (release only)" aria-label="Releases partial freeze" />
                <select name="reasonCode" aria-label="Partial reason code" required defaultValue="">
                  <option value="" disabled>
                    Reason code…
                  </option>
                  <optgroup label="Freeze">
                    {codes("freeze").map((c) => (
                      <option key={`pf-${c.code}`} value={c.code}>
                        {c.label}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Release">
                    {codes("unfreeze").map((c) => (
                      <option key={`pu-${c.code}`} value={c.code}>
                        {c.label}
                      </option>
                    ))}
                  </optgroup>
                </select>
                <input name="kycCase" inputMode="numeric" pattern="[1-9][0-9]*" placeholder="KYC case # (optional)" aria-label="Partial KYC case" />
                <input name="strCase" inputMode="numeric" pattern="[1-9][0-9]*" placeholder="STR case # (optional)" aria-label="Partial STR case" />
                <textarea name="reason" required minLength={10} maxLength={500} placeholder="Reason (no CNIC, IBAN or phone number)" aria-label="Partial reason" />
                <div className="row">
                  <button className="btn" type="submit" name="decision" value="request">
                    Propose partial with security key
                  </button>
                </div>
              </StepUpForm>
            </div>
          ) : null}
        </div>
      </section>
    </Shell>
  );
}
