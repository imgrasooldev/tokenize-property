import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActionPanel } from "@/components/ActionPanel";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { pkt, short } from "@/lib/format";
import { stateChip } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";
import { committee, propertyName, rupees, voteLabel } from "@/lib/server/votes";

export const metadata: Metadata = { title: "Committee meeting" };

/**
 * One investment-committee meeting (S-01 P7, OB-33; migration 0026): the file the members decide on
 * (reviews, valuations, the legal opinion's qualifications, current documents with SHA-256), the
 * votes and the outcome so far. A member votes approve / reject / abstain with a reason, or records
 * a conflict; the chair closes with the SHA-256 of the minutes. Quorum, independence, the majority
 * rule and OB-SOD-1 are decided by the database (property.cast_vote / property.close_ic).
 */
export default async function CommitteePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const valid = /^[1-9]\d{0,17}$/.test(id);
  const officer = await requirePage("property.read", `/committees/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const m = await committee(officer.sessionHash, id);
  if (!m) notFound();
  const quals = Array.isArray(m.qualifications) ? m.qualifications : [];

  return (
    <Shell officer={officer} current="/committees" title={`Committee meeting #${String(m.id)}`}>
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="meeting">
          <h2 id="meeting">
            <span data-testid="committee-title">{propertyName(m.property)}</span> <span className="sp" />
            <span className={stateChip(m.status)} data-testid="committee-status">
              {m.status}
            </span>
          </h2>
          <dl className="kv">
            <dt>Property</dt>
            <dd className="mono small">{m.property.id}</dd>
            <dt>Property state</dt>
            <dd>
              <span className={stateChip(m.property.state)}>{m.property.state}</span>
            </dd>
            <dt>Sponsor KYB</dt>
            <dd>{m.property.sponsorState ?? "–"}</dd>
            <dt>Chair</dt>
            <dd className="mono">
              {m.chair}
              {m.chairIsMe ? " (you)" : ""}
            </dd>
            <dt>Opened</dt>
            <dd>{pkt(m.openedAt)}</dd>
            {m.closedAt ? (
              <>
                <dt>Closed</dt>
                <dd>{pkt(m.closedAt)}</dd>
                <dt>Minutes SHA-256</dt>
                <dd className="mono small">{m.minutesSha256}</dd>
              </>
            ) : null}
            <dt>File digest</dt>
            <dd className="mono small">{m.digest}</dd>
          </dl>
          {m.p7Problem ? (
            <p className="alert bad" data-testid="p7-problem">
              Not approvable now: {m.p7Problem}
            </p>
          ) : null}
        </section>
        <section className="card" aria-labelledby="outcome">
          <h2 id="outcome">Outcome so far</h2>
          <dl className="kv" data-testid="committee-outcome">
            <dt>Non-conflicted votes</dt>
            <dd className="mono">
              {m.outcome.voters} of {m.outcome.needed} needed
            </dd>
            <dt>Approvals</dt>
            <dd className="mono">{m.outcome.approvals}</dd>
            <dt>Quorum (incl. independent)</dt>
            <dd>
              <span className={m.outcome.quorum ? "chip ok" : "chip warn"}>{m.outcome.quorum ? "yes" : "not yet"}</span>
            </dd>
            <dt>Would close as</dt>
            <dd>
              <span className={m.outcome.approved ? "chip ok" : "chip bad"}>{m.outcome.approved ? "approved (Legal Approved)" : "not approved"}</span>
            </dd>
          </dl>
          <p className="small mu">OB-33: at least {m.outcome.needed} non-conflicted votes including an independent member; more approvals than half the votes; no independent member against.</p>
        </section>
      </div>

      <div className="g2">
        <section className="card" aria-labelledby="dd">
          <h2 id="dd">Due diligence</h2>
          <div className="tbl-wrap">
            <table className="t" data-testid="committee-reviews">
              <thead>
                <tr>
                  <th scope="col">Discipline</th>
                  <th scope="col">Reviewer</th>
                  <th scope="col">Decision</th>
                  <th scope="col">Current</th>
                </tr>
              </thead>
              <tbody>
                {m.reviews.map((r) => (
                  <tr key={r.discipline}>
                    <td>{r.discipline}</td>
                    <td className="mono small">{r.reviewer ?? "–"}</td>
                    <td>{r.decision ? <span className={r.decision === "fail" ? "chip bad" : "chip ok"}>{r.decision}</span> : "–"}</td>
                    <td>{r.fresh ? "yes" : <span className="chip bad">reopened or stale</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small">
            Valuations: {m.valuation.count} · lowest {rupees(m.valuation.lowestPaisa)} · {m.valuation.ok ? "within tolerance" : (m.valuation.problem ?? "not valid")}
          </p>
          {quals.length > 0 ? (
            <>
              <b className="small">Legal opinion qualifications (accepted by approving, OB-28)</b>
              <ul className="small">
                {quals.map((x, i) => (
                  <li key={i}>{typeof x === "string" ? x : JSON.stringify(x)}</li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
        <section className="card" aria-labelledby="docs">
          <h2 id="docs">Current documents</h2>
          <div className="tbl-wrap">
            <table className="t" data-testid="committee-documents">
              <thead>
                <tr>
                  <th scope="col">Type</th>
                  <th scope="col">SHA-256</th>
                </tr>
              </thead>
              <tbody>
                {m.documents.map((d) => (
                  <tr key={d.id}>
                    <td>{d.type}</td>
                    <td className="mono small" title={d.sha256}>
                      {short(d.sha256, 10)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="card" aria-labelledby="votes">
        <h2 id="votes">Votes</h2>
        {m.votes.length === 0 ? (
          <p className="empty">No vote yet.</p>
        ) : (
          <div className="sig" data-testid="committee-votes">
            {m.votes.map((v) => (
              <div key={v.member} className={v.vote === "approve" ? "y" : "n"}>
                <b className={v.vote === "approve" ? "up" : "dn"}>
                  {v.member} {v.independent ? <span className="chip">independent</span> : null} · {voteLabel(v)}
                </b>
                <div className="di small">
                  {pkt(v.at)} · {v.conflict ? v.conflictNote : (v.reason ?? "")}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="g2">
        <section className="card" aria-labelledby="vote">
          <h2 id="vote">Your vote</h2>
          <ActionPanel
            csrf={officer.csrf}
            action={`/api/committees/${String(m.id)}/vote`}
            hidden={{ digest: m.digest }}
            actions={
              m.blockers.length > 0
                ? [{ action: "approve", label: "Vote", blockers: m.blockers }]
                : [
                    { action: "approve", label: "Approve with security key", blockers: [], tone: "ok" },
                    { action: "reject", label: "Reject with security key", blockers: [], tone: "no" },
                    { action: "abstain", label: "Abstain with security key", blockers: [] },
                    { action: "conflict", label: "Record a conflict (no vote)", blockers: [] },
                  ]
            }
            reasonLabel="Reason for your vote, or the conflict you declare (recorded in the property and admin audit chains; 10 to 500 characters)"
            note="One vote per member; recorded next to the file digest you reviewed."
          />
        </section>
        <section className="card" aria-labelledby="close">
          <h2 id="close">Close the meeting (chair)</h2>
          <ActionPanel
            csrf={officer.csrf}
            action={`/api/committees/${String(m.id)}/close`}
            hidden={{ digest: m.closeDigest }}
            actions={[{ action: "close", label: "Close with security key", blockers: m.closeBlockers, tone: "ok" }]}
            extra={
              <>
                <label className="small mu" htmlFor="minutes">
                  SHA-256 of the signed minutes (64 hex characters)
                </label>
                <input id="minutes" name="minutes" className="mono" required pattern="[0-9a-fA-F]{64}" maxLength={64} autoComplete="off" />
              </>
            }
            reasonLabel="Closing note (recorded in the property and admin audit chains; 10 to 500 characters)"
            reasonId="close-reason"
            note="Approved: the property becomes Legal Approved. Bound to the votes you see."
          />
        </section>
      </div>
    </Shell>
  );
}
