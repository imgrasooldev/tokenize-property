import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DecisionPanel, Flash, GateChip } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { pkt } from "@/lib/format";
import { payoutBatch, rupees } from "@/lib/server/approvals";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Payout batch" };

/**
 * One payout batch (ADR 0009): every line (no names: subject id prefix, bank, last four IBAN digits),
 * totals with held lines, the reconciliation gate, the items digest the decision is bound to, and
 * once submitted the bank file's SHA-256. The bank function decides (maker-checker, gate, payability).
 */
export default async function PayoutBatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const valid = /^[1-9]\d{0,17}$/.test(id);
  const officer = await requirePage("approvals.read", `/approvals/payouts/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const b = await payoutBatch(officer.sessionHash, id);
  if (!b) notFound();
  const held = b.lines.filter((l) => l.held);

  return (
    <Shell officer={officer} current="/approvals" title="Payout batch" actions={<GateChip gate={b.gate} />}>
      <Flash q={q} />
      <div className="kpis">
        <div className="kpi">
          <div className="label">Batch</div>
          <div className="val" style={{ fontSize: 15 }} data-testid="batch-ref">
            {b.reference}
          </div>
          <div className="sub">{b.kind === "follow_up" ? `follow-up of #${String(b.parentId)}` : "distribution batch"}</div>
        </div>
        <div className="kpi">
          <div className="label">Distribution total</div>
          <div className="val">{rupees(b.totalPaisa)}</div>
          <div className="sub">
            #{b.distributionId} · {b.token}
          </div>
        </div>
        <div className="kpi">
          <div className="label">Paid now</div>
          <div className="val up">{rupees(b.paidPaisa)}</div>
          <div className="sub">{b.items - held.length} lines</div>
        </div>
        <div className="kpi">
          <div className="label">Held</div>
          <div className={held.length ? "val am" : "val"}>{rupees(b.heldPaisa)}</div>
          <div className="sub">{held.length} lines (stay owed)</div>
        </div>
        <div className="kpi">
          <div className="label">Status</div>
          <div className="val" style={{ fontSize: 16 }} data-testid="batch-status">
            {b.status}
          </div>
          <div className="sub">
            maker {b.createdBy}
            {b.decidedBy ? ` · checker ${b.decidedBy}` : ""}
          </div>
        </div>
        <div className="kpi">
          <div className="label">Payout gate</div>
          <div className={b.gate.allowed ? "val up" : "val dn"}>{b.gate.allowed ? "Open" : "Closed"}</div>
          <div className="sub">{b.gate.reason}</div>
        </div>
      </div>

      <div className="g2">
        <section className="card" aria-labelledby="lines">
          <h2 id="lines">
            Lines <span className="sp" />
            <span className="mu small" style={{ fontWeight: 400 }}>
              no names or full IBANs in the portal
            </span>
          </h2>
          <div className="tbl-wrap">
            <table className="t" data-testid="batch-lines">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Investor</th>
                  <th scope="col">Account</th>
                  <th scope="col" className="n">
                    Amount
                  </th>
                  <th scope="col">State</th>
                </tr>
              </thead>
              <tbody>
                {b.lines.map((l) => (
                  <tr key={l.line}>
                    <td className="mono">{l.line}</td>
                    <td className="mono small">{l.subject}…</td>
                    <td className="mono small">{l.held ? "–" : `${l.bank ?? ""} ····${l.ibanLast4 ?? ""}`}</td>
                    <td className="n">{rupees(l.amountPaisa)}</td>
                    <td>
                      {l.held ? <span className="chip warn">held: {l.heldReason}</span> : l.returned ? <span className="chip bad">returned</span> : <span className="chip ok">paid in this batch</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {b.items > b.lines.length ? <p className="small di">Showing the first {b.lines.length} of {b.items} lines.</p> : null}
        </section>

        <div className="stack">
          <section className="card" aria-labelledby="dig">
            <h2 id="dig">What you approve</h2>
            <dl className="kv">
              <dt>Items digest (v{b.itemsDigestVersion})</dt>
              <dd className="mono small" data-testid="items-digest">
                {b.itemsDigest}
              </dd>
              <dt>Bank file SHA-256</dt>
              <dd className="mono small">{b.fileSha256 ?? "made at submission (record before send)"}</dd>
              <dt>Created</dt>
              <dd>{pkt(b.createdAt)}</dd>
              <dt>Decided</dt>
              <dd>{b.decidedAt ? `${pkt(b.decidedAt)} · ${b.decisionReason ?? ""}` : "–"}</dd>
              <dt>Submitted</dt>
              <dd>{b.submittedAt ? `${pkt(b.submittedAt)} by ${b.submittedBy ?? ""} · journal #${String(b.journalId)}` : "–"}</dd>
            </dl>
            {b.problems ? <p className="alert bad">{b.problems}</p> : null}
            {b.status === "approved" ? (
              <p className="small mu" style={{ marginBlockStart: 8 }}>
                Approved batches are submitted by the bank service (record before send): it books the payout and records the bank file hash in one
                transaction, after checking the gate again.
              </p>
            ) : null}
          </section>
          <section className="card" aria-labelledby="dec">
            <h2 id="dec">Your decision</h2>
            <DecisionPanel
              csrf={officer.csrf}
              action={`/api/approvals/payouts/${String(b.id)}/decide`}
              hidden={{ itemsDigest: b.itemsDigest }}
              blockers={b.blockers}
              approveBlockers={b.approveBlockers}
              note="Recorded in the bank and admin audit chains."
            />
          </section>
        </div>
      </div>
    </Shell>
  );
}
