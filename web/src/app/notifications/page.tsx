import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { markReadAction, saveNotifySettingsAction } from "@/app/actions/notifications";
import { PortalShell } from "@/components/Shell";
import { notifyDict } from "@/lib/i18n-notify";
import { notifyTime } from "@/lib/notify-render";
import { getDict } from "@/lib/server/lang";
import { logError } from "@/lib/server/log";
import { inbox, notifySettings, type InboxItem, type NotifySettings } from "@/lib/server/notifications";
import { currentSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Notifications · Property Token" };

/**
 * The investor notification centre (T-028, migration 0030 NP-8): every notice the platform raised
 * for this investor (security, account and investment updates; offers only after an opt-in), newest
 * first, with mark-as-read, and the message settings (language, SMS/e-mail for updates, the
 * optional offers consent). Security alerts cannot be switched off. Plain forms: no JavaScript needed.
 */
export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ e?: string; saved?: string }> }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const { lang } = await getDict();
  const l = notifyDict(lang);
  const { e, saved } = await searchParams;
  const error = e === "rate" ? l.err_rate : e === "invalid" ? l.err_invalid : e === "generic" ? l.err_generic : null;

  let items: InboxItem[] | null;
  let settings: NotifySettings | null;
  try {
    [items, settings] = await Promise.all([inbox(session.hash, lang), notifySettings(session.hash)]);
  } catch (err) {
    logError("notifications page", err);
    items = null;
    settings = null;
  }
  const unread = items?.filter((i) => !i.read).length ?? 0;

  return (
    <PortalShell active="notifications" title={l.title}>
      <p className="note" style={{ marginBlockEnd: 14 }}>
        {l.intro}
      </p>
      {error && (
        <div className="alert" role="alert" style={{ marginBlockEnd: 14 }}>
          {error}
        </div>
      )}
      <div className="detail">
        <section className="panel" aria-labelledby="inbox-h">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
            <h2 id="inbox-h">
              {l.title}{" "}
              {unread > 0 && <span className="chip amber">{l.unreadLabel.replace("{n}", String(unread))}</span>}
            </h2>
            {unread > 0 && (
              <form action={markReadAction}>
                <input type="hidden" name="id" value="all" />
                <button type="submit" className="btn secondary small">
                  {l.markAllRead}
                </button>
              </form>
            )}
          </div>
          {items === null ? (
            <p className="note">{l.loadError}</p>
          ) : settings === null ? (
            <p className="note">{l.noKyc}</p>
          ) : items.length === 0 ? (
            <p className="note">{l.none}</p>
          ) : (
            <ul className="notices" aria-label={l.title}>
              {items.map((n) => (
                <li key={n.id} className={`notice ${n.read ? "" : "unread"}`} style={{ listStyle: "none", paddingBlock: 12, borderBlockEnd: "1px solid var(--line, #2a2f3a)", overflowWrap: "anywhere" }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                    {!n.read && <span className="chip amber">{l.newChip}</span>}
                    {n.category === "security" && <span className="chip red">{l.security}</span>}
                    {n.category === "marketing" && <span className="chip gray">{l.offer}</span>}
                    <b>{n.title}</b>
                  </div>
                  <div className="fine" dir="ltr" style={{ textAlign: lang === "ur" ? "right" : "left" }}>
                    {notifyTime(n.at.toISOString(), lang)}
                  </div>
                  {n.paragraphs.map((p, i) => (
                    <p key={i} style={{ marginBlock: 6, whiteSpace: "pre-line" }}>
                      {p}
                    </p>
                  ))}
                  {!n.read && (
                    <form action={markReadAction}>
                      <input type="hidden" name="id" value={n.id} />
                      <button type="submit" className="linklike">
                        {l.markRead}
                      </button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="fine">{l.allTimesPkt}</p>
        </section>

        {settings && (
          <section className="panel" id="settings" aria-labelledby="settings-h">
            <h2 id="settings-h">{l.settingsTitle}</h2>
            {saved === "1" && (
              <div className="alert ok" role="status">
                {l.saved}
              </div>
            )}
            <form action={saveNotifySettingsAction} className="form">
              <fieldset>
                <legend>{l.language}</legend>
                <label>
                  <input type="radio" name="locale" value="en" defaultChecked={settings.locale === "en"} /> {l.langEn}
                </label>{" "}
                <label>
                  <input type="radio" name="locale" value="ur" defaultChecked={settings.locale === "ur"} /> {l.langUr}
                </label>
              </fieldset>
              <fieldset>
                <legend>{l.updatesTitle}</legend>
                <p className="fine">{l.updatesNote}</p>
                <label>
                  <input type="checkbox" name="sms" defaultChecked={settings.smsEnabled} /> {l.bySms}
                </label>{" "}
                <label>
                  <input type="checkbox" name="email" defaultChecked={settings.emailEnabled} /> {l.byEmail}
                </label>
                <p className="fine">{l.securityNote}</p>
              </fieldset>
              <fieldset>
                <legend>{l.offersTitle}</legend>
                <p className="fine">{l.offersConsent}</p>
                <label>
                  <input type="checkbox" name="mktSms" defaultChecked={settings.smsMarketing} /> {l.bySms}
                </label>{" "}
                <label>
                  <input type="checkbox" name="mktEmail" defaultChecked={settings.emailMarketing} /> {l.byEmail}
                </label>
              </fieldset>
              <button type="submit" className="btn">
                {l.save}
              </button>
            </form>
            <h3 className="small" style={{ marginBlockStart: 18 }}>
              {l.contactsTitle}
            </h3>
            <dl className="kv">
              <dt>{l.bySms}</dt>
              <dd>
                <span className={`chip ${settings.smsOnFile ? "green" : "gray"}`}>{settings.smsOnFile ? l.onFile : l.notOnFile}</span>
              </dd>
              <dt>{l.byEmail}</dt>
              <dd>
                <span className={`chip ${settings.emailOnFile ? "green" : "gray"}`}>{settings.emailOnFile ? l.onFile : l.notOnFile}</span>
              </dd>
            </dl>
            <p className="fine">{l.contactsNote}</p>
          </section>
        )}
      </div>
    </PortalShell>
  );
}
