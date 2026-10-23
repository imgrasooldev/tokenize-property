import type { Lang } from "../i18n";
import { renderNotice, type PlaceholderType } from "../notify-render";
import { db } from "./db";
import { logError } from "./log";

/**
 * The investor notification centre (T-028, migration 0030 NP-8). Every call goes through a
 * session-bound notify.web_* function: the database derives the investor and their KYC subject
 * from the session and returns or changes only that investor's notifications and settings. No
 * phone number or e-mail address ever reaches the website (only whether one is on file).
 */
export interface InboxItem {
  id: string;
  kind: string;
  category: "security" | "transactional" | "marketing";
  at: Date;
  read: boolean;
  title: string;
  paragraphs: string[];
}

interface InboxRow {
  id: string;
  kind: string;
  category: InboxItem["category"];
  params: Record<string, string>;
  placeholders: Record<string, { type: PlaceholderType }>;
  created_at: Date;
  read_at: Date | null;
  subject: string | null;
  body: string | null;
}

export async function inbox(session: Buffer, lang: Lang, limit = 50): Promise<InboxItem[]> {
  const { rows } = await (await db()).query<InboxRow>("SELECT * FROM notify.web_inbox($1, $2, $3)", [session, lang, limit]);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    category: r.category,
    at: r.created_at,
    read: r.read_at !== null,
    ...renderNotice({ kind: r.kind, subject: r.subject, body: r.body, params: r.params, placeholders: r.placeholders }, lang),
  }));
}

/** Unread count for the navigation badge; 0 when it cannot be read (the badge is a convenience). */
export async function unreadCount(session: Buffer): Promise<number> {
  try {
    const { rows } = await (await db()).query<{ n: number }>("SELECT notify.web_unread($1) AS n", [session]);
    return rows[0]?.n ?? 0;
  } catch (e) {
    logError("unread notifications", e);
    return 0;
  }
}

/** Marks these notifications (null: all) of the signed-in investor as read; returns how many changed. */
export async function markRead(session: Buffer, ids: string[] | null): Promise<number> {
  const { rows } = await (await db()).query<{ n: number }>("SELECT notify.web_mark_read($1, $2::bigint[]) AS n", [session, ids]);
  return rows[0]?.n ?? 0;
}

export interface NotifySettings {
  locale: Lang;
  smsOnFile: boolean;
  emailOnFile: boolean;
  smsEnabled: boolean;
  emailEnabled: boolean;
  smsMarketing: boolean;
  emailMarketing: boolean;
}

/** The signed-in investor's settings, or null without a KYC record (nothing to configure). */
export async function notifySettings(session: Buffer): Promise<NotifySettings | null> {
  const { rows } = await (await db()).query<{
    locale: string;
    sms_on_file: boolean;
    email_on_file: boolean;
    sms_enabled: boolean;
    email_enabled: boolean;
    sms_marketing: boolean;
    email_marketing: boolean;
  }>("SELECT * FROM notify.web_settings($1)", [session]);
  const r = rows[0];
  if (!r) return null;
  return {
    locale: r.locale === "ur" ? "ur" : "en",
    smsOnFile: r.sms_on_file,
    emailOnFile: r.email_on_file,
    smsEnabled: r.sms_enabled,
    emailEnabled: r.email_enabled,
    smsMarketing: r.sms_marketing,
    emailMarketing: r.email_marketing,
  };
}

export type SetResult = "ok" | "session" | "invalid";

/** One setting change (web_set writes only real changes, each audited). */
export async function setNotify(session: Buffer, what: "locale" | "transactional" | "marketing", channel: "sms" | "email" | null, enabled: boolean | null, value: string | null): Promise<SetResult> {
  const { rows } = await (await db()).query<{ r: string }>("SELECT notify.web_set($1, $2, $3, $4, $5) AS r", [session, what, channel, enabled, value]);
  const r = rows[0]?.r;
  return r === "ok" || r === "session" ? r : "invalid";
}
