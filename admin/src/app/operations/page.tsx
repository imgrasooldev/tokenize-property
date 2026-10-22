import type { Metadata } from "next";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { short } from "@/lib/format";
import { CHARGE_KINDS, FEE_TYPES, periods, rupees, statement } from "@/lib/server/operations";
import { stateChip } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Property operations" };

const TOKEN = /^0x[0-9a-f]{40}$/;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Property operations (spec S-03, migration 0021): periods with rent collected and the net
 * distributable amount; for one period the operating statement (OP-30/OP-31) with the collections,
 * expenses, fees and reserve movements behind it, and the distribution calculations. Makers propose
 * charges here (with the evidence's SHA-256); checkers decide them on the charge page.
 */
export default async function OperationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("operations.read", "/operations");
  const q = await searchParams;
  const token = typeof q.token === "string" && TOKEN.test(q.token) ? q.token : null;
  const period = typeof q.period === "string" && PERIOD.test(q.period) ? q.period : null;
  const list = await periods(officer.sessionHash);
  const st = token && period ? await statement(officer.sessionHash, token, period) : null;
  const canPropose = officer.permissions.has("operations.request");

  return (
    <Shell officer={officer} current="/operations" title="Property operations">
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="periods">
          <h2 id="periods">Periods</h2>
          {list.length === 0 ? (
            <p className="empty">No collections or charges recorded yet.</p>
          ) : (
            <div className="tbl-wrap">
              <table className="t" data-testid="periods">
                <thead>
                  <tr>
                    <th scope="col">Period</th>
                    <th scope="col">Token</th>
                    <th scope="col" className="n">
                      Collected
                    </th>
                    <th scope="col" className="n">
                      Distributable
                    </th>
                    <th scope="col">State</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((p) => (
                    <tr key={`${p.token}-${p.period}`}>
                      <td className="mono">
                        <a href={`/operations?token=${p.token}&period=${p.period}`}>{p.period}</a>
                      </td>
                      <td className="mono small">{short(p.token)}</td>
                      <td className="n mono">{rupees(p.collected)}</td>
                      <td className="n mono">{rupees(p.distributable)}</td>
                      <td>
                        {p.pending > 0 ? <span className="chip warn">{p.pending} pending</span> : null}{" "}
                        {p.distribution ? (
                          <a href={`/operations/distributions/${String(p.distribution.id)}`}>
                            <span className={stateChip(p.distribution.status)}>calc #{p.distribution.id} {p.distribution.status}</span>
                          </a>
                        ) : (
                          <span className="chip">open</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        {canPropose ? (
          <section className="card" aria-labelledby="propose">
            <h2 id="propose">Propose a charge</h2>
            <form method="post" action="/api/operations/charges" encType="multipart/form-data" className="stack">
              <input type="hidden" name="csrf" value={officer.csrf} />
              <input name="token" required pattern="0x[0-9a-f]{40}" placeholder="Token address (0x…)" aria-label="Token" defaultValue={token ?? ""} />
              <input name="period" required pattern="\d{4}-\d{2}" placeholder="Period YYYY-MM" aria-label="Period" defaultValue={period ?? ""} />
              <select name="kind" required defaultValue="" aria-label="Kind">
                <option value="" disabled>
                  Kind…
                </option>
                {CHARGE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k.replace("_", " ")}
                  </option>
                ))}
              </select>
              <select name="feeType" defaultValue="" aria-label="Fee type (fees only)">
                <option value="">Fee type (fees only)</option>
                {FEE_TYPES.map((k) => (
                  <option key={k} value={k}>
                    {k.replace("_", " ")}
                  </option>
                ))}
              </select>
              <input name="payee" pattern="[a-z0-9][a-z0-9_\-]{1,39}" placeholder="Payee reference (expenses and fees)" aria-label="Payee" />
              <input name="amount" required inputMode="decimal" placeholder="Amount in rupees, e.g. 175000.00" aria-label="Amount in rupees" />
              <textarea name="description" required minLength={5} maxLength={300} placeholder="What it is for (no CNIC, IBAN or phone number)" aria-label="Description" />
              <label className="small mu" htmlFor="evidence-file">
                Evidence (invoice or calculation): only its SHA-256 is kept
              </label>
              <input id="evidence-file" type="file" name="evidenceFile" />
              <input name="evidence" pattern="[0-9a-f]{64}" placeholder="…or paste the SHA-256 of the evidence" aria-label="Evidence SHA-256" />
              <button className="btn" type="submit">
                Propose
              </button>
            </form>
          </section>
        ) : null}
      </div>

      {st ? (
        <section className="card" aria-labelledby="stmt" style={{ marginBlockStart: 16 }}>
          <h2 id="stmt">
            Operating statement {st.period} <span className="mono small mu">{st.token}</span> <span className="sp" />
            {st.locked ? <span className="chip warn">locked by a calculation</span> : <span className="chip">open</span>}
          </h2>
          <dl className="kv" data-testid="statement-totals">
            <dt>Rent collected (cash)</dt>
            <dd className="mono">{rupees(st.totals.collected)}</dd>
            <dt>Operating expenses</dt>
            <dd className="mono">− {rupees(st.totals.expenses)}</dd>
            <dt>Fees (manager / trustee / platform)</dt>
            <dd className="mono">
              − {rupees(st.totals.fees.total)} ({rupees(st.totals.fees.propertyManager)} / {rupees(st.totals.fees.trustee)} / {rupees(st.totals.fees.platform)})
            </dd>
            <dt>Net operating cash</dt>
            <dd className="mono">{rupees(st.totals.netOperatingCash)}</dd>
            <dt>Reserve contribution / release</dt>
            <dd className="mono">
              − {rupees(st.totals.reserveContribution)} / + {rupees(st.totals.reserveRelease)}
            </dd>
            <dt>
              <b>Distributable gross</b>
            </dt>
            <dd className="mono" data-testid="distributable">
              <b>{rupees(st.totals.distributableGross)}</b>
              {st.totals.shortfall !== "0" ? <span className="dn"> · shortfall {rupees(st.totals.shortfall)}</span> : null}
            </dd>
            <dt>Pending decisions</dt>
            <dd>{st.totals.pending}</dd>
          </dl>
          <h3>Charges</h3>
          {st.charges.length === 0 ? (
            <p className="empty">None.</p>
          ) : (
            <div className="tbl-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Payee</th>
                    <th scope="col">Description</th>
                    <th scope="col" className="n">
                      Amount
                    </th>
                    <th scope="col">State</th>
                  </tr>
                </thead>
                <tbody>
                  {st.charges.map((c) => (
                    <tr key={c.id}>
                      <td className="mono">
                        <a href={`/operations/charges/${String(c.id)}`}>#{c.id}</a>
                      </td>
                      <td className="small">{c.kind === "fee" ? `fee: ${c.feeType ?? ""}` : c.kind.replace("_", " ")}</td>
                      <td className="mono small">{c.payee ?? "–"}</td>
                      <td className="small">{c.description}</td>
                      <td className="n mono">{rupees(c.amount)}</td>
                      <td>
                        <span className={stateChip(c.status)}>{c.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3>Collections (from bank statement lines)</h3>
          {st.collections.length === 0 ? (
            <p className="empty">None.</p>
          ) : (
            <div className="tbl-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Bank reference</th>
                    <th scope="col">Value date</th>
                    <th scope="col">Source</th>
                    <th scope="col" className="n">
                      Amount
                    </th>
                    <th scope="col">State</th>
                  </tr>
                </thead>
                <tbody>
                  {st.collections.map((c) => (
                    <tr key={c.id}>
                      <td className="mono">#{c.id}</td>
                      <td className="mono small">{c.reference}</td>
                      <td className="mono small">{c.valueDate}</td>
                      <td className="small">{c.source.replace("_", " ")}</td>
                      <td className="n mono">{rupees(c.amount)}</td>
                      <td>
                        <span className={stateChip(c.status)}>{c.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3>Distribution calculations</h3>
          {st.distributions.length === 0 ? (
            <p className="empty">None yet (operations service: ops:run -- calculate).</p>
          ) : (
            <ul className="checks">
              {st.distributions.map((d) => (
                <li key={d.id}>
                  <a href={`/operations/distributions/${String(d.id)}`}>
                    Calculation #{d.id} · record date {d.recordDate} · block {d.recordBlock}
                  </a>{" "}
                  <span className={stateChip(d.status)}>{d.status}</span> <span className="mono small">gross {rupees(d.gross)} · WHT {rupees(d.wht)} · net {rupees(d.net)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </Shell>
  );
}
