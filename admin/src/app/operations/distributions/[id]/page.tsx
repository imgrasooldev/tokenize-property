import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DecisionPanel, Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { StepUpForm } from "@/components/StepUp";
import { pkt, short } from "@/lib/format";
import { stateChip } from "@/lib/server/compliance";
import { distribution, ratePercent, rentOnchain, rupees } from "@/lib/server/operations";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Distribution calculation" };

/**
 * One distribution calculation (S-03 OT-4..OT-6): the operating statement it is based on, the
 * record block, every line (units, gross, filer status as of a date, rate, WHT, net = Merkle leaf),
 * the statement and tax schedule hashes, and the checker's decision. Investors appear only as a
 * subject reference and a wallet; tax status is shown to officers only, never published.
 */
export default async function DistributionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const valid = /^[1-9]\d{0,17}$/.test(id);
  const officer = await requirePage("operations.read", `/operations/distributions/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const d = await distribution(officer.sessionHash, id);
  if (!d) notFound();
  const rent = d.status === "approved" || d.status === "booked" ? await rentOnchain(officer.sessionHash, id) : null;

  return (
    <Shell officer={officer} current="/operations" title={`Distribution calculation #${String(d.id)}`}>
      <Flash q={q} />
      {d.placeholder > 0 ? (
        <p className="alert bad" role="note" data-testid="placeholder-warning">
          {d.placeholder} line(s) use PLACEHOLDER tax rates (LEGAL/TAX TO CONFIRM). Approval is refused until confirmed rates are in force.
        </p>
      ) : null}
      <div className="g2">
        <section className="card" aria-labelledby="calc">
          <h2 id="calc">
            {d.period} · {d.incomeType.replace("_", " ")} <span className="sp" />
            <span className={stateChip(d.status)} data-testid="distribution-status">
              {d.status}
            </span>
          </h2>
          <dl className="kv">
            <dt>Token</dt>
            <dd className="mono small">{d.token}</dd>
            <dt>Record date / block</dt>
            <dd className="mono">
              {d.recordDate} / {d.recordBlock}
            </dd>
            <dt>Collected − expenses − fees</dt>
            <dd className="mono">
              {rupees(d.collected)} − {rupees(d.expenses)} − {rupees(d.fees)}
            </dd>
            <dt>Reserve − / +</dt>
            <dd className="mono">
              {rupees(d.reserveContribution)} / {rupees(d.reserveRelease)}
            </dd>
            <dt>Distributable gross</dt>
            <dd className="mono">{rupees(d.gross)}</dd>
            <dt>Withholding (FBR)</dt>
            <dd className="mono" data-testid="wht">
              {rupees(d.wht)}
            </dd>
            <dt>Net to holders (on chain)</dt>
            <dd className="mono" data-testid="net">
              {rupees(d.net)}
            </dd>
            <dt>Holders / units</dt>
            <dd className="mono">
              {d.holders} / {d.units}
            </dd>
            <dt>Flagged lines</dt>
            <dd>{d.flagged > 0 ? <span className="chip warn">{d.flagged} flagged (non-filer rate applied)</span> : "none"}</dd>
            <dt>Merkle root</dt>
            <dd className="mono small">{d.root ?? "statement not attached yet"}</dd>
            <dt>Statement hash</dt>
            <dd className="mono small">{d.statementHash ?? "–"}</dd>
            <dt>Tax schedule hash</dt>
            <dd className="mono small">{d.taxScheduleHash ?? "–"}</dd>
            <dt>Calculated / attached by</dt>
            <dd className="mono">
              {d.calculatedBy} · {pkt(d.calculatedAt)} / {d.attachedBy ?? "–"}
            </dd>
            <dt>Decided</dt>
            <dd>{d.decidedBy ? `${d.decidedBy} · ${pkt(d.decidedAt)} · ${d.decisionReason ?? ""}` : "–"}</dd>
            <dt>On chain / booked</dt>
            <dd className="mono">{d.onchainId ? `distribution ${d.onchainId} · booked ${pkt(d.bookedAt)}` : "–"}</dd>
          </dl>
        </section>
        <section className="card" aria-labelledby="dec">
          <h2 id="dec">Your decision</h2>
          <DecisionPanel
            csrf={officer.csrf}
            action={`/api/operations/distributions/${String(d.id)}/decide`}
            hidden={{ digest: d.digest }}
            blockers={d.blockers.reject}
            approveBlockers={d.blockers.approve.filter((b) => !d.blockers.reject.includes(b))}
            approveLabel="Approve for publication"
            note="Recompute from the chain and the statement first (OP-SOD-2). Rejecting returns it to the maker."
          />
        </section>
      </div>
      {rent ? (
        <section className="card" aria-labelledby="chain" style={{ marginBlockStart: 16 }} data-testid="rent-onchain">
          <h2 id="chain">On chain: publish → 48 h → finalize → book</h2>
          <dl className="kv">
            <dt>Publish command</dt>
            <dd className="mono small">
              {rent.publishCommand ? `#${String(rent.publishCommand.id)} ${rent.publishCommand.status} · ${rent.publishCommand.by} · ${pkt(rent.publishCommand.at)}` : "–"}
              {rent.publishCommand?.lastError ? <span className="dn"> {rent.publishCommand.lastError}</span> : null}
            </dd>
            <dt>On-chain distribution</dt>
            <dd className="mono small" data-testid="rent-onchain-status">
              {rent.onchain ? `${rent.onchain.id} · ${rent.onchain.status} · registry ${short(rent.onchain.registry)}` : "not published yet"}
            </dd>
            <dt>Challenge window closes</dt>
            <dd className="mono">{rent.onchain?.closesAt ? pkt(rent.onchain.closesAt) : "–"}</dd>
            <dt>Finalize command</dt>
            <dd className="mono small">
              {rent.finalizeCommand ? `#${String(rent.finalizeCommand.id)} ${rent.finalizeCommand.status} · ${rent.finalizeCommand.by} · ${pkt(rent.finalizeCommand.at)}` : "–"}
              {rent.finalizeCommand?.lastError ? <span className="dn"> {rent.finalizeCommand.lastError}</span> : null}
            </dd>
          </dl>
          <StepUpForm csrf={officer.csrf} action={`/api/operations/distributions/${String(d.id)}/rent`}>
            <div className="row">
              {(
                [
                  ["publish", "Publish on chain", rent.blockers.publish],
                  ["finalize", "Finalize (after 48 h)", rent.blockers.finalize],
                  ["book", "Book journals", rent.blockers.book],
                ] as const
              ).map(([step, label, blocker]) => (
                <button key={step} className="btn" type="submit" name="step" value={step} disabled={blocker !== null} title={blocker ?? undefined}>
                  {label}
                </button>
              ))}
            </div>
          </StepUpForm>
          <ul className="small mu" data-testid="rent-blockers">
            {rent.blockers.publish ? <li>Publish: {rent.blockers.publish}</li> : null}
            {rent.blockers.finalize ? <li>Finalize: {rent.blockers.finalize}</li> : null}
            {rent.blockers.book ? <li>Book: {rent.blockers.book}</li> : null}
          </ul>
        </section>
      ) : null}
      <section className="card" aria-labelledby="lines" style={{ marginBlockStart: 16 }}>
        <h2 id="lines">Lines (leaf = wallet, net paisa)</h2>
        <div className="tbl-wrap">
          <table className="t" data-testid="lines">
            <thead>
              <tr>
                <th scope="col">Wallet</th>
                <th scope="col">Investor</th>
                <th scope="col" className="n">
                  Units
                </th>
                <th scope="col" className="n">
                  Gross
                </th>
                <th scope="col">Status (ATL as of)</th>
                <th scope="col" className="n">
                  Rate
                </th>
                <th scope="col" className="n">
                  WHT
                </th>
                <th scope="col" className="n">
                  Net
                </th>
              </tr>
            </thead>
            <tbody>
              {d.lines.map((l) => (
                <tr key={l.wallet}>
                  <td className="mono small">{short(l.wallet)}</td>
                  <td className="mono small">{l.subject ?? "no KYC"}</td>
                  <td className="n mono">{l.units}</td>
                  <td className="n mono">{rupees(l.gross)}</td>
                  <td className="small">
                    {l.status.replace("_", "-")} {l.asOf ? `(${l.asOf})` : ""} {l.flag ? <span className="chip warn" title={l.flag}>flagged</span> : null}
                  </td>
                  <td className="n mono">
                    {ratePercent(l.ratePpm)}
                    {l.placeholder ? <span className="dn"> placeholder</span> : null}
                  </td>
                  <td className="n mono">{rupees(l.wht)}</td>
                  <td className="n mono">{rupees(l.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </Shell>
  );
}
