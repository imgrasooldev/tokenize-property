import Link from "next/link";
import { redirect } from "next/navigation";
import { PortalShell } from "@/components/Shell";
import { fileComplaintAction } from "@/app/actions/complaints";
import { CATEGORIES, cl, complaintsDict } from "@/lib/i18n-complaints";
import { pktTime } from "@/lib/i18n-catalog";
import { fill } from "@/lib/i18n-verify";
import { myComplaints } from "@/lib/server/complaints";
import { getDict } from "@/lib/server/lang";
import { currentSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** Complaints (migration 0040): file a new one, and the list of the investor's own. */
export default async function ComplaintsPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const { lang } = await getDict();
  const l = complaintsDict(lang);
  const q = await searchParams;
  const rows = await myComplaints(session.hash);
  const err = q.e === "rate" ? l.err_rate : q.e === "invalid" ? l.err_invalid : q.e ? l.err_generic : null;
  return (
    <PortalShell active="complaints" title={l.title}>
      {err && (
        <p className="alert" role="alert">
          {err}
        </p>
      )}
      <div className="detail">
        <section className="panel" aria-labelledby="new-h">
          <h2 id="new-h">{l.newTitle}</h2>
          <p className="note">{fill(l.intro, { a: "2", r: "15" })}</p>
          <form action={fileComplaintAction} className="stack" data-testid="complaint-form">
            <label htmlFor="category">{l.category}</label>
            <select id="category" name="category" required>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {cl(l, "cat_", c)}
                </option>
              ))}
            </select>
            <label htmlFor="title">{l.subject}</label>
            <input id="title" name="title" required minLength={5} maxLength={120} />
            <label htmlFor="body">{l.details}</label>
            <textarea id="body" name="body" required minLength={10} maxLength={2000} rows={5} />
            <p className="fine">{l.noIdNumbers}</p>
            <button type="submit" className="btn">
              {l.file}
            </button>
          </form>
        </section>
        <section className="panel" aria-labelledby="mine-h">
          <h2 id="mine-h">{l.mine}</h2>
          {rows.length === 0 ? (
            <p className="note">{l.none}</p>
          ) : (
            <ul className="plain stack" data-testid="my-complaints">
              {rows.map((c) => (
                <li key={c.id}>
                  <Link href={`/complaints/${String(c.id)}`}>
                    <b dir="ltr">{c.ref}</b> · {c.title}
                  </Link>{" "}
                  <span className="chip">{cl(l, "st_", c.status)}</span>
                  <span className="fine">
                    {" "}
                    {cl(l, "cat_", c.category)} · {fill(l.resolveBy, { t: pktTime(c.resolveDue) })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </PortalShell>
  );
}
