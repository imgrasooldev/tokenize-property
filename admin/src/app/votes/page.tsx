import type { Metadata } from "next";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { StepUpForm } from "@/components/StepUp";
import { pkt, short } from "@/lib/format";
import { polls } from "@/lib/server/votes-polls";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Token-holder votes" };

/**
 * Token-holder polls (migration 0046): an operations maker proposes, a trustee officer approves,
 * investors vote on the website by their units at the record block, a maker closes the poll after
 * its closing time and the tally, turnout and quorum are recorded. Running totals are not shown.
 */
export default async function VotesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("operations.read", "/votes");
  const q = await searchParams;
  const data = await polls(officer.sessionHash);
  const maker = officer.permissions.has("operations.request");
  const trustee = officer.permissions.has("trustee.decide");
  return (
    <Shell officer={officer} current="/votes" title="Token-holder votes">
      <Flash q={q} />
      <p className="alert warn" role="note">
        Which matters need a vote and which quorum applies are set by the trust deed (LEGAL TO CONFIRM). Holdings count at the record block, never at voting time.
      </p>
      {maker ? (
        <section className="card" aria-labelledby="new" style={{ marginBlockEnd: 16 }}>
          <h2 id="new">Propose a poll</h2>
          <StepUpForm csrf={officer.csrf} action="/api/votes">
            <div className="row">
              <label className="sr-only" htmlFor="token">
                Token
              </label>
              <select id="token" name="token" required>
                {data.tokens.map((t) => (
                  <option key={t.token} value={t.token}>
                    {short(t.token)} (indexed to block {t.cursor})
                  </option>
                ))}
              </select>
              <label htmlFor="recordBlock">Record block</label>
              <input id="recordBlock" name="recordBlock" inputMode="numeric" required />
              <label htmlFor="quorum">Quorum %</label>
              <input id="quorum" name="quorum" inputMode="numeric" defaultValue="0" required />
            </div>
            <label htmlFor="title">Title</label>
            <input id="title" name="title" maxLength={120} required />
            <label htmlFor="question">Question</label>
            <textarea id="question" name="question" maxLength={1000} required />
            <label htmlFor="options">Options (one per line, 2 to 6)</label>
            <textarea id="options" name="options" rows={3} defaultValue={"Yes\nNo"} required />
            <div className="row">
              <label htmlFor="opens">Opens</label>
              <input id="opens" name="opens" type="datetime-local" required />
              <label htmlFor="closes">Closes</label>
              <input id="closes" name="closes" type="datetime-local" required />
            </div>
            <div className="row">
              <button className="btn" type="submit">
                Propose with security key
              </button>
            </div>
          </StepUpForm>
        </section>
      ) : null}
      <section className="card" aria-labelledby="list">
        <h2 id="list">Polls</h2>
        {data.polls.length === 0 ? <p className="empty">No poll yet.</p> : null}
        <div className="stack" data-testid="polls">
          {data.polls.map((p) => (
            <article key={p.id} className="card" style={{ background: "rgba(255,255,255,.02)" }}>
              <div className="row">
                <b>
                  #{p.id} {p.title}
                </b>
                <span className="sp" />
                <span className="chip">{p.status}</span>
              </div>
              <p className="small">{p.question}</p>
              <p className="small mu">
                Token {short(p.token)} · record block {p.recordBlock} · {pkt(p.opensAt)} to {pkt(p.closesAt)} · quorum {(p.quorumPpm / 10_000).toFixed(2)} % · {p.ballots} ballot(s) ·
                proposed by {p.proposedBy}
                {p.decidedBy ? `, decided by ${p.decidedBy}` : ""}
              </p>
              {p.result ? (
                <ul className="small">
                  {p.result.options.map((o) => (
                    <li key={o.option}>
                      {o.option}: {o.weight} units ({o.ballots} ballot(s))
                    </li>
                  ))}
                  <li>
                    Turnout {(p.result.turnoutPpm / 10_000).toFixed(2)} % of {p.result.unitsAtRecord} units · quorum {p.result.quorumMet ? "met" : "not met"}
                  </li>
                </ul>
              ) : (
                <ul className="small mu">
                  {p.options.map((o) => (
                    <li key={o}>{o}</li>
                  ))}
                </ul>
              )}
              {p.status === "proposed" && trustee && p.proposedBy !== officer.handle ? (
                <StepUpForm csrf={officer.csrf} action={`/api/votes/${String(p.id)}/act`}>
                  <label className="sr-only" htmlFor={`vr-${String(p.id)}`}>
                    Reason
                  </label>
                  <textarea id={`vr-${String(p.id)}`} name="reason" required minLength={10} maxLength={500} placeholder="Reason (at least 10 characters)" />
                  <div className="row">
                    <button className="btn ok" type="submit" name="action" value="approve">
                      Approve with security key
                    </button>
                    <button className="btn no" type="submit" name="action" value="reject">
                      Reject
                    </button>
                  </div>
                </StepUpForm>
              ) : null}
              {p.canClose && maker ? (
                <StepUpForm csrf={officer.csrf} action={`/api/votes/${String(p.id)}/act`}>
                  <div className="row">
                    <button className="btn" type="submit" name="action" value="close">
                      Close and count
                    </button>
                  </div>
                </StepUpForm>
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </Shell>
  );
}
