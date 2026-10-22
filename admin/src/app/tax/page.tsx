import type { Metadata } from "next";
import { DecisionPanel, Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { StepUpForm } from "@/components/StepUp";
import { pkt, short } from "@/lib/format";
import { stateChip } from "@/lib/server/compliance";
import { INCOME_STATUSES, ratePercent, rupees, taxOverview } from "@/lib/server/operations";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Withholding tax" };

/**
 * FBR withholding (spec S-03 OP-40..OP-46, migration 0021): the rate table as versioned, dated
 * configuration (seeded with PLACEHOLDERS: LEGAL/TAX TO CONFIRM), rate changes by one tax officer
 * approved by another, the filer-status checks against the Active Taxpayers List, and withheld vs
 * remitted per token and period. No CNIC is shown anywhere.
 */
export default async function TaxPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("tax.read", "/tax");
  const q = await searchParams;
  const t = await taxOverview(officer.sessionHash);
  const canDecide = officer.permissions.has("tax.decide");
  const proposed = t.rates.filter((r) => r.state === "proposed");
  const placeholders = t.rates.some((r) => r.placeholder && r.inForce);

  return (
    <Shell officer={officer} current="/tax" title="Withholding tax">
      <Flash q={q} />
      {placeholders ? (
        <p className="alert bad" role="note" data-testid="placeholder-banner">
          Rates marked PLACEHOLDER are illustrative (LEGAL/TAX TO CONFIRM) and not tax advice. Distributions using them cannot be approved
          {t.allowPlaceholder ? " (this database allows it: local development only)" : ""}.
        </p>
      ) : null}
      <section className="card" aria-labelledby="rates">
        <h2 id="rates">Rates (by record date)</h2>
        <div className="tbl-wrap">
          <table className="t" data-testid="rates">
            <thead>
              <tr>
                <th scope="col">Income type</th>
                <th scope="col">Status</th>
                <th scope="col" className="n">
                  Rate
                </th>
                <th scope="col">Effective from</th>
                <th scope="col">Version</th>
                <th scope="col">Basis</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {t.rates.map((r) => (
                <tr key={r.id}>
                  <td className="mono small">{r.incomeType}</td>
                  <td className="small">{r.status.replace("_", "-")}</td>
                  <td className="n mono">{ratePercent(r.ratePpm)}</td>
                  <td className="mono small">{r.effectiveFrom}</td>
                  <td className="mono">v{r.version}</td>
                  <td className="small">
                    {r.placeholder ? <span className="chip bad">PLACEHOLDER</span> : null} {r.basis}
                  </td>
                  <td>
                    <span className={stateChip(r.state === "active" ? "approved" : r.state)}>{r.state}</span> {r.inForce ? <span className="chip ok">in force</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small mu">
          WHT per line = gross × rate, rounded half up to the paisa; net = gross − WHT (the amount in the investor&apos;s Merkle leaf). Income types:{" "}
          {t.incomeTypes.map((i) => `${i.code} (${i.label})`).join(", ")}.
        </p>
      </section>

      <div className="g2" style={{ marginBlockStart: 16 }}>
        <section className="card" aria-labelledby="pending">
          <h2 id="pending">Proposed rate changes</h2>
          {proposed.length === 0 ? (
            <p className="empty">None waiting.</p>
          ) : (
            proposed.map((r) => (
              <div key={r.id} className="stack" data-testid={`rate-${String(r.id)}`}>
                <p className="small">
                  <b>
                    {r.incomeType} · {r.status.replace("_", "-")} → {ratePercent(r.ratePpm)}
                  </b>{" "}
                  from {r.effectiveFrom} (v{r.version}) · {r.basis} · proposed by <span className="mono">{r.proposedBy}</span> {pkt(r.proposedAt)}
                </p>
                <DecisionPanel
                  csrf={officer.csrf}
                  action={`/api/tax/rates/${String(r.id)}/decide`}
                  hidden={{ digest: r.digest }}
                  blockers={r.blockers}
                  note="Maker-checker: a different tax officer approves."
                />
              </div>
            ))
          )}
        </section>
        {canDecide ? (
          <section className="card" aria-labelledby="propose">
            <h2 id="propose">Propose a rate</h2>
            <StepUpForm csrf={officer.csrf} action="/api/tax/rates">
              <select name="incomeType" required defaultValue="" aria-label="Income type">
                <option value="" disabled>
                  Income type…
                </option>
                {t.incomeTypes.map((i) => (
                  <option key={i.code} value={i.code}>
                    {i.label}
                  </option>
                ))}
              </select>
              <select name="status" required defaultValue="" aria-label="Filer status">
                <option value="" disabled>
                  Filer status…
                </option>
                {INCOME_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s.replace("_", "-")}
                  </option>
                ))}
              </select>
              <input name="rate" required inputMode="decimal" placeholder="Rate in percent, e.g. 15 or 12.5" aria-label="Rate in percent" />
              <input name="effectiveFrom" required type="date" min={t.today} aria-label="Effective from" />
              <textarea name="basis" required minLength={10} maxLength={300} placeholder="Legal basis: section, Finance Act, circular" aria-label="Basis" />
              <button className="btn" type="submit" name="decision" value="propose">
                Propose with security key
              </button>
            </StepUpForm>
          </section>
        ) : null}
      </div>

      <div className="g2" style={{ marginBlockStart: 16 }}>
        <section className="card" aria-labelledby="filer">
          <h2 id="filer">Filer status (Active Taxpayers List)</h2>
          <dl className="kv">
            <dt>Investors with a sealed CNIC</dt>
            <dd>{t.filer.sealedCnics}</dd>
            <dt>Checks recorded</dt>
            <dd className="mono small">
              {Object.entries(t.filer.checks)
                .map(([k, v]) => `${k} ${String(v)}`)
                .join(" · ") || "none"}
            </dd>
            <dt>Last check</dt>
            <dd>{pkt(t.filer.lastCheck)}</dd>
          </dl>
          <p className="small mu">Checks run in the tax service (mock ATL provider until the real one is contracted). A result older than 30 days at a record date falls back to the non-filer rate.</p>
        </section>
        <section className="card" aria-labelledby="pos">
          <h2 id="pos">Withheld and remitted</h2>
          {t.positions.length === 0 ? (
            <p className="empty">No booked distribution yet.</p>
          ) : (
            <div className="tbl-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th scope="col">Period</th>
                    <th scope="col">Token</th>
                    <th scope="col" className="n">
                      Withheld
                    </th>
                    <th scope="col" className="n">
                      Remitted
                    </th>
                    <th scope="col" className="n">
                      Outstanding
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {t.positions.map((p) => (
                    <tr key={`${p.token}-${p.period}`}>
                      <td className="mono">{p.period}</td>
                      <td className="mono small">{short(p.token)}</td>
                      <td className="n mono">{rupees(p.withheld)}</td>
                      <td className="n mono">{rupees(p.remitted)}</td>
                      <td className="n mono">{p.outstanding === "0" ? <span className="chip ok">0</span> : rupees(p.outstanding)}</td>
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
