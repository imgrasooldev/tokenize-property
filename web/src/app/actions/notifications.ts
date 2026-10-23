"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { MARKETING_CONSENT_VERSION } from "@/lib/i18n-notify";
import { logError } from "@/lib/server/log";
import { markRead, setNotify, type SetResult } from "@/lib/server/notifications";
import { take } from "@/lib/server/rate-limit";
import { currentSession } from "@/lib/server/session";

/**
 * Notification centre actions (T-028, migration 0030 NP-8). Plain forms (they work without
 * JavaScript); the database scopes every change to the session's investor.
 */
async function signedIn(): Promise<{ investorId: string; session: Buffer }> {
  const s = await currentSession();
  if (!s) redirect("/login");
  return { investorId: s.investorId, session: s.hash };
}

const idSchema = z.union([z.literal("all"), z.string().regex(/^[1-9][0-9]{0,17}$/)]);

/** Marks one notification ("id") or all of them ("all") as read. */
export async function markReadAction(formData: FormData): Promise<void> {
  const me = await signedIn();
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) redirect("/notifications?e=invalid");
  if (!take("notify", me.investorId)) redirect("/notifications?e=rate");
  try {
    await markRead(me.session, id.data === "all" ? null : [id.data]);
  } catch (e) {
    logError("mark read", e);
    redirect("/notifications?e=generic");
  }
  revalidatePath("/notifications");
  redirect("/notifications");
}

const settingsSchema = z.object({
  locale: z.enum(["en", "ur"]),
  sms: z.boolean(),
  email: z.boolean(),
  mktSms: z.boolean(),
  mktEmail: z.boolean(),
});

/** Saves the message settings: language, transactional channels, marketing opt-in (with the consent text version). */
export async function saveNotifySettingsAction(formData: FormData): Promise<void> {
  const me = await signedIn();
  if (!take("notify", me.investorId)) redirect("/notifications?e=rate#settings");
  const on = (k: string): boolean => formData.get(k) === "on";
  const parsed = settingsSchema.safeParse({ locale: formData.get("locale"), sms: on("sms"), email: on("email"), mktSms: on("mktSms"), mktEmail: on("mktEmail") });
  if (!parsed.success) redirect("/notifications?e=invalid#settings");
  const s = parsed.data;
  let results: SetResult[];
  try {
    results = [
      await setNotify(me.session, "locale", null, null, s.locale),
      await setNotify(me.session, "transactional", "sms", s.sms, null),
      await setNotify(me.session, "transactional", "email", s.email, null),
      await setNotify(me.session, "marketing", "sms", s.mktSms, MARKETING_CONSENT_VERSION),
      await setNotify(me.session, "marketing", "email", s.mktEmail, MARKETING_CONSENT_VERSION),
    ];
  } catch (e) {
    logError("notify settings", e);
    redirect("/notifications?e=generic#settings");
  }
  // A live session was checked above: "session" here means no KYC record (nothing to configure).
  if (results.includes("session")) redirect("/notifications?e=invalid#settings");
  if (results.includes("invalid")) redirect("/notifications?e=invalid#settings");
  revalidatePath("/notifications");
  redirect("/notifications?saved=1#settings");
}
