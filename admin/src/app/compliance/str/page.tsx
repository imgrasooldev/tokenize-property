import type { Metadata } from "next";
import { Fragment } from "react";
import { ComplianceTabs } from "@/components/ComplianceTabs";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { pkt } from "@/lib/format";
import { StepUpForm } from "@/components/StepUp";
import { goamlConfig, stateChip, strList } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "STR cases" };

/**
 * Suspicious transaction report cases (Step 6c, migration 0019 C-4). Confidential: compliance
 * officers and auditors only, never operations, never the investor (tipping-off, AML Act 2010).
 * Nothing is sent to the FMU automatically: the MLRO files the export by hand.
 */
export default async function StrPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("compliance.read", "/compliance/str");
  const q = await searchParams;
  const [s, goaml] = await Promise.all([strList(officer.sessionHash), goamlConfig(officer.sessionHash)]);
  const pending = [...goaml.settings.filter((x) => x.placeholder), ...goaml.indicators.filter((x) => x.placeholder)].length;
  const canDecide = officer.permissions.has("compliance.decide");

  return (
    <Shell officer={officer} current="/compliance/str" title="STR cases">
      <ComplianceTabs current="/compliance/str" />
      <Flash q={q} />
      <p className="alert bad" role="note">
        Confidential (tipping-off): never discuss an STR case with the investor or with operations staff.
      </p>
      <div className="g2">
        <section className="card" aria-labelledby="cases">
          <h2 id="cases">Cases</h2>
          {s.cases.length === 0 ? (
            <p className="empty">No STR case.</p>
          ) : (
            <div className="tbl-wrap">
              <table className="t" data-testid="str-cases">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Category</th>
                    <th scope="col">Investor</th>
                    <th scope="col">State</th>
                    <th scope="col" className="n">
                      Notes
                    </th>
                    <th scope="col">Opened</th>
                    <th scope="col">FMU ref</th>
                  </tr>
                </thead>
                <tbody>
                  {s.cases.map((c) => (
                    <tr key={c.id}>
                      <td className="mono">
                        <a href={`/compliance/str/${String(c.id)}`}>#{c.id}</a>
                      </td>
                      <td className="mono small">{c.category}</td>
                      <td className="mono small">{c.subject ?? "–"}</td>
                      <td>
                        <span className={stateChip(c.status)}>{c.status.replace("_", " ")}</span> {c.overdue ? <span className="chip bad">overdue</span> : null}
                      </td>
                      <td className="n">{c.notes}</td>
                      <td className="small">
                        <span className="mono">{c.openedBy}</span> · {pkt(c.openedAt)}
                      </td>
                      <td className="mono small">{c.fmuReference ?? "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        {canDecide ? (
          <section className="card" aria-labelledby="open">
            <h2 id="open">Open a case</h2>
            <form method="post" action="/api/compliance/str" className="stack">
              <input type="hidden" name="csrf" value={officer.csrf} />
              <select name="category" aria-label="Category" required defaultValue="">
                <option value="" disabled>
                  Category…
                </option>
                {s.categories.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </select>
              <input name="subject" placeholder="Investor reference (UUID from a KYC case, optional)" aria-label="Investor reference" pattern="[0-9a-f-]{36}" />
              <textarea name="summary" required minLength={20} maxLength={2000} placeholder="What raised the suspicion (no CNIC, IBAN or phone number)" aria-label="Summary" />
              <button className="btn" type="submit">
                Open STR case
              </button>
            </form>
          </section>
        ) : null}
      </div>

      <section className="card" aria-labelledby="goaml" style={{ marginBlockStart: 12 }} data-testid="goaml">
        <h2 id="goaml">
          goAML values <span className="sp" />
          <span className={pending ? "chip warn" : "chip ok"}>{pending ? `${String(pending)} placeholder(s) to confirm with the FMU` : "confirmed"}</span>
        </h2>
        <p className="small mu">
          Every STR export contains a goAML draft built from these values. The MLRO completes the person fields from the KYC record before filing.
        </p>
        <div className="g2">
          <dl className="kv">
            {goaml.settings.map((x) => (
              <Fragment key={x.key}>
                <dt>{x.key}</dt>
                <dd>
                  {x.value} {x.placeholder ? <span className="chip warn">placeholder</span> : null}
                </dd>
              </Fragment>
            ))}
          </dl>
          <dl className="kv">
            {goaml.indicators.map((x) => (
              <Fragment key={x.category}>
                <dt>{x.label}</dt>
                <dd className="mono">
                  {x.indicator} {x.placeholder ? <span className="chip warn">placeholder</span> : null}
                </dd>
              </Fragment>
            ))}
          </dl>
        </div>
        {canDecide ? (
          <StepUpForm csrf={officer.csrf} action="/api/compliance/goaml">
            <div className="row" style={{ marginBlockStart: 8 }}>
              <label className="sr-only" htmlFor="goaml-target">
                Value
              </label>
              <select id="goaml-target" name="target" required defaultValue="">
                <option value="" disabled>
                  Value…
                </option>
                {goaml.settings.map((x) => (
                  <option key={x.key} value={`setting:${x.key}`}>
                    {x.key}
                  </option>
                ))}
                {goaml.indicators.map((x) => (
                  <option key={x.category} value={`indicator:${x.category}`}>
                    indicator: {x.label}
                  </option>
                ))}
              </select>
              <label className="sr-only" htmlFor="goaml-value">
                New value
              </label>
              <input id="goaml-value" name="value" required maxLength={200} placeholder="Value confirmed by the FMU" />
              <label className="sr-only" htmlFor="goaml-reason">
                Reason
              </label>
              <input id="goaml-reason" name="reason" required minLength={10} maxLength={500} placeholder="Reason (10+ characters)" />
              <button className="btn prime" type="submit">
                Save with security key
              </button>
            </div>
          </StepUpForm>
        ) : null}
      </section>
    </Shell>
  );
}
