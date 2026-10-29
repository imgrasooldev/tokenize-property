import { notFound, redirect } from "next/navigation";
import { PortalShell } from "@/components/Shell";
import { complaintAction } from "@/app/actions/complaints";
import { cl, complaintsDict } from "@/lib/i18n-complaints";
import { pktTime } from "@/lib/i18n-catalog";
import { fill } from "@/lib/i18n-verify";
import { myComplaint } from "@/lib/server/complaints";
import { getDict } from "@/lib/server/lang";
import { currentSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** One complaint (migration 0040): the conversation, the history, and the investor's next step. */
export default async function ComplaintPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ e?: string; ok?: string; r?: string }> }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const { id } = await params;
  const c = await myComplaint(session.hash, id);
  if (!c) notFound();
  const { lang } = await getDict();
  const l = complaintsDict(lang);
  const q = await searchParams;
  const err = q.e === "rate" ? l.err_rate : q.e === "invalid" ? l.err_invalid : q.e ? l.err_generic : null;
  const ok = q.ok === "filed" ? fill(l.ok_filed, { r: (q.r ?? c.ref).slice(0, 12) }) : q.ok ? l.ok_done : null;
  const canReply = c.status !== "closed";
  return (
    <PortalShell active="complaints" title={`${l.title} · ${c.ref}`}>
      {ok && (
        <p className="up" role="status">
          {ok}
        </p>
      )}
      {err && (
        <p className="alert" role="alert">
          {err}
        </p>
      )}
      <div className="detail">
        <section className="panel" aria-labelledby="c-h" data-testid="complaint">
          <h2 id="c-h">
            {c.title} <span className="chip" data-testid="complaint-status">{cl(l, "st_", c.status)}</span>
          </h2>
          <p className="fine">
            <span dir="ltr">{c.ref}</span> · {cl(l, "cat_", c.category)} · {fill(l.resolveBy, { t: pktTime(c.resolveDue) })}
          </p>
          {c.resolution && (
            <p className="note">
              <b>{l.resolution}:</b> {c.resolution}
            </p>
          )}
          <h3 className="small">{l.history}</h3>
          <ul className="plain small">
            {c.events.map((e, i) => (
              <li key={i}>
                <span dir="ltr">{pktTime(e.at)}</span> · {cl(l, "ev_", e.action)}
              </li>
            ))}
          </ul>
        </section>
        <section className="panel" aria-labelledby="conv-h">
          <h2 id="conv-h">{l.conversation}</h2>
          <ul className="plain stack">
            {c.messages.map((m, i) => (
              <li key={i}>
                <b>{m.from === "officer" ? l.team : l.you}</b> <span className="fine" dir="ltr">{pktTime(m.at)}</span>
                <p style={{ whiteSpace: "pre-wrap" }}>{m.body}</p>
              </li>
            ))}
          </ul>
          {canReply && (
            <form action={complaintAction} className="stack">
              <input type="hidden" name="id" value={String(c.id)} />
              <label className="sr-only" htmlFor="reply">
                {l.reply}
              </label>
              <textarea id="reply" name="body" rows={3} maxLength={2000} />
              <p className="fine">{l.noIdNumbers}</p>
              <div className="btn-row">
                <button type="submit" className="btn" name="action" value="reply">
                  {l.reply}
                </button>
                {c.status === "resolved" && (
                  <>
                    <button type="submit" className="btn secondary" name="action" value="close">
                      {l.accept}
                    </button>
                    <button type="submit" className="btn secondary" name="action" value="reopen">
                      {l.reopen}
                    </button>
                  </>
                )}
              </div>
              {c.reopenUntil && <p className="fine">{fill(l.reopenUntil, { t: pktTime(c.reopenUntil) })}</p>}
            </form>
          )}
        </section>
      </div>
    </PortalShell>
  );
}
