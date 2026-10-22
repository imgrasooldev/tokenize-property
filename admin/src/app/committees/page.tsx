import type { Metadata } from "next";
import { ActionPanel } from "@/components/ActionPanel";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { pkt } from "@/lib/format";
import { stateChip } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";
import { committees, propertyName, type CommitteeRow } from "@/lib/server/votes";

export const metadata: Metadata = { title: "Investment committee" };

function Rows({ list, testid }: { list: CommitteeRow[]; testid: string }) {
  return (
    <div className="tbl-wrap">
      <table className="t" data-testid={testid}>
        <thead>
          <tr>
            <th scope="col">Meeting</th>
            <th scope="col">Property</th>
            <th scope="col">Chair</th>
            <th scope="col">Status</th>
            <th scope="col" className="n">
              Votes
            </th>
            <th scope="col">Opened</th>
          </tr>
        </thead>
        <tbody>
          {list.map((m) => (
            <tr key={m.id}>
              <td className="mono">
                <a href={`/committees/${String(m.id)}`}>#{m.id}</a>
              </td>
              <td>{propertyName(m.property)}</td>
              <td className="mono small">
                {m.chair}
                {m.chairIsMe ? <span className="chip">you</span> : null}
              </td>
              <td>
                <span className={stateChip(m.status)}>{m.status}</span> {m.status === "open" && m.quorum ? <span className="chip ok">quorum</span> : null}
              </td>
              <td className="n mono">
                {m.votes}
                {m.mine ? " ✓" : ""}
              </td>
              <td className="mono small">{pkt(m.openedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Investment committee (S-01 P7, OB-33; migration 0026): open meetings, files ready for a meeting
 * and the latest outcomes. Members vote and the chair closes on the meeting's own page.
 */
export default async function CommitteesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("property.read", "/committees");
  const q = await searchParams;
  const c = await committees(officer.sessionHash);
  return (
    <Shell officer={officer} current="/committees" title="Investment committee">
      <Flash q={q} />
      <section className="card" aria-labelledby="open">
        <h2 id="open">
          Open meetings <span className="sp" />
          <span className="mu small" style={{ fontWeight: 400 }}>
            quorum {c.quorum} non-conflicted votes incl. an independent member · majority approves · no independent against
          </span>
        </h2>
        {c.open.length === 0 ? <p className="empty">No open meeting.</p> : <Rows list={c.open} testid="committees-open" />}
      </section>
      <section className="card" aria-labelledby="ready">
        <h2 id="ready">Ready for a committee</h2>
        <p className="small mu">Due diligence complete (every review passed and fresh, valuations within tolerance, sponsor KYB-approved). A committee member opens the meeting and chairs it.</p>
        {c.ready.length === 0 ? (
          <p className="empty">No file is waiting for a committee.</p>
        ) : (
          c.ready.map((r) => (
            <div key={r.property.id} className="card" data-testid="committee-ready">
              <b>{propertyName(r.property)}</b> <span className="mono di small">{r.property.id}</span>
              <ActionPanel
                csrf={officer.csrf}
                action="/api/committees/open"
                hidden={{ property: r.property.id }}
                reasonId={`open-reason-${r.property.id}`}
                actions={[{ action: "open", label: "Open the meeting and chair it", blockers: r.openBlockers, tone: "ok" }]}
                note="You become the chair; recorded in the property and admin audit chains."
              />
            </div>
          ))
        )}
      </section>
      <section className="card" aria-labelledby="recent">
        <h2 id="recent">Latest outcomes</h2>
        {c.recent.length === 0 ? <p className="empty">No meeting closed yet.</p> : <Rows list={c.recent} testid="committees-recent" />}
      </section>
    </Shell>
  );
}
