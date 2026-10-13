import type { Metadata } from "next";
import { ComplianceTabs } from "@/components/ComplianceTabs";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { StepUpForm } from "@/components/StepUp";
import { pkt, short } from "@/lib/format";
import { freezeList, stateChip } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Freezes" };

/**
 * Freeze and unfreeze requests (Step 6c, migration 0019 C-3): one compliance officer proposes with a
 * reason code, a different one decides; an approval puts the command in the outbox for the signing
 * service (existing compliance.freeze policy, new compliance.unfreeze policy).
 */
export default async function FreezesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("compliance.read", "/compliance/freezes");
  const q = await searchParams;
  const f = await freezeList(officer.sessionHash);
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
    </Shell>
  );
}
