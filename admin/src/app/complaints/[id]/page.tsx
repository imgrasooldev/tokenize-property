import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { StepUpForm } from "@/components/StepUp";
import { pkt } from "@/lib/format";
import { complaint } from "@/lib/server/complaints";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Complaint" };

/**
 * One complaint (migration 0040): deadlines, the conversation and the history, and for support and
 * operations makers the next steps (acknowledge, reply, resolve with a summary, refer to compliance).
 * The investor is shown by support reference only.
 */
export default async function ComplaintPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const valid = /^[1-9]\d{0,17}$/.test(id);
  const officer = await requirePage("complaints.read", `/complaints/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const c = await complaint(officer.sessionHash, id);
  if (!c) notFound();
  const handle = officer.permissions.has("complaints.handle");
  const active = c.status === "open" || c.status === "acknowledged";
  return (
    <Shell officer={officer} current="/complaints" title={`Complaint ${c.ref}`}>
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="sum">
          <h2 id="sum">
            {c.title} <span className="sp" />
            <span className="chip" data-testid="complaint-status">
              {c.status}
            </span>
          </h2>
          <dl className="kv">
            <dt>Category</dt>
            <dd>{c.category}</dd>
            <dt>Investor (support reference)</dt>
            <dd className="mono">{c.investorRef ?? "no KYC record"}</dd>
            <dt>Filed</dt>
            <dd>{pkt(c.createdAt)}</dd>
            <dt>Acknowledge by / done</dt>
            <dd>
              {pkt(c.ackDue)} / {c.acknowledgedAt ? pkt(c.acknowledgedAt) : "–"}
            </dd>
            <dt>Resolve by / done</dt>
            <dd>
              {pkt(c.resolveDue)} / {c.resolvedAt ? pkt(c.resolvedAt) : "–"}
            </dd>
            <dt>Resolution</dt>
            <dd>{c.resolution ?? "–"}</dd>
          </dl>
          <h3>History</h3>
          <ul className="small">
            {c.events.map((e, i) => (
              <li key={i}>
                {pkt(e.at)} · {e.action} · <span className="mono">{e.actor.startsWith("web:") ? "investor" : e.actor}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="card" aria-labelledby="conv">
          <h2 id="conv">Conversation</h2>
          <div className="stack" data-testid="complaint-messages">
            {c.messages.map((m, i) => (
              <article key={i} className="card" style={{ background: m.from === "officer" ? "rgba(255,255,255,.04)" : "rgba(255,255,255,.01)" }}>
                <p className="small mu">
                  {m.from === "officer" ? m.author : "Investor"} · {pkt(m.at)}
                </p>
                <p style={{ whiteSpace: "pre-wrap" }}>{m.body}</p>
              </article>
            ))}
          </div>
          {handle && c.status !== "closed" && c.status !== "referred" ? (
            <StepUpForm csrf={officer.csrf} action={`/api/complaints/${String(c.id)}/act`}>
              <label htmlFor="body">Message to the investor (no CNIC, bank account or phone numbers)</label>
              <textarea id="body" name="body" rows={4} maxLength={2000} />
              <div className="row">
                {c.status === "open" ? (
                  <button className="btn" type="submit" name="action" value="acknowledge">
                    Acknowledge
                  </button>
                ) : null}
                <button className="btn" type="submit" name="action" value="reply">
                  Reply
                </button>
                {active ? (
                  <button className="btn ok" type="submit" name="action" value="resolve">
                    Resolve (message = resolution)
                  </button>
                ) : null}
                {active ? (
                  <button className="btn no" type="submit" name="action" value="refer">
                    Refer to compliance
                  </button>
                ) : null}
              </div>
            </StepUpForm>
          ) : null}
        </section>
      </div>
    </Shell>
  );
}
