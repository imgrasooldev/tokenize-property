import { redirect } from "next/navigation";
import { PortalShell } from "@/components/Shell";
import { VoteForm } from "@/components/VoteForm";
import { formatNumber } from "@/lib/i18n";
import { pktTime } from "@/lib/i18n-catalog";
import { fill } from "@/lib/i18n-verify";
import { pollState, votesDict } from "@/lib/i18n-votes";
import { getDict } from "@/lib/server/lang";
import { currentSession } from "@/lib/server/session";
import { myPolls } from "@/lib/server/votes";

export const dynamic = "force-dynamic";

/** Token-holder votes (migration 0046): polls of the tokens the investor held at the record block. */
export default async function VotesPage() {
  const session = await currentSession();
  if (!session) redirect("/login");
  const { lang } = await getDict();
  const l = votesDict(lang);
  const rows = await myPolls(session.hash);
  return (
    <PortalShell active="votes" title={l.title}>
      <p className="note">{l.intro}</p>
      {rows.length === 0 ? (
        <p className="note">{l.none}</p>
      ) : (
        <div className="stack" data-testid="polls">
          {rows.map((p) => (
            <section key={p.id} className="panel" aria-labelledby={`poll-${String(p.id)}`}>
              <h2 id={`poll-${String(p.id)}`}>
                {p.title} <span className="chip">{pollState(l, p.state)}</span>
              </h2>
              <p>{p.question}</p>
              <p className="fine">
                {fill(l.weight, { b: String(p.recordBlock), w: formatNumber(BigInt(p.weight), lang) })} ·{" "}
                {fill(l.window, { a: pktTime(p.opensAt), b: pktTime(p.closesAt) })} · {fill(l.quorum, { q: (p.quorumPpm / 10_000).toFixed(0) })}
              </p>
              {p.myChoice !== null && <p className="up">{fill(l.voted, { o: p.options[p.myChoice] ?? "" })}</p>}
              {p.state === "open" && p.myChoice === null && <VoteForm l={l} poll={p.id} options={p.options} />}
              {p.result && (
                <ul className="plain small">
                  {p.result.options.map((o) => (
                    <li key={o.option}>
                      {o.option}: {formatNumber(BigInt(o.weight), lang)}
                    </li>
                  ))}
                  <li>{fill(l.turnout, { t: (p.result.turnoutPpm / 10_000).toFixed(1), m: p.result.quorumMet ? l.met : l.notMet })}</li>
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </PortalShell>
  );
}
