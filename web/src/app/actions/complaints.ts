"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { CATEGORIES } from "@/lib/i18n-complaints";
import { actOnComplaint, fileComplaint } from "@/lib/server/complaints";
import { logError } from "@/lib/server/log";
import { take } from "@/lib/server/rate-limit";
import { currentSession } from "@/lib/server/session";

/**
 * Complaint actions (migration 0040). Plain forms (they work without JavaScript); the database
 * scopes every change to the session's investor and checks the text again.
 */
async function signedIn(): Promise<{ investorId: string; session: Buffer }> {
  const s = await currentSession();
  if (!s) redirect("/login");
  return { investorId: s.investorId, session: s.hash };
}

const fileSchema = z.object({
  category: z.enum(CATEGORIES),
  title: z.string().trim().min(5).max(120),
  body: z.string().trim().min(10).max(2000),
});

export async function fileComplaintAction(formData: FormData): Promise<void> {
  const me = await signedIn();
  const parsed = fileSchema.safeParse({ category: formData.get("category"), title: formData.get("title"), body: formData.get("body") });
  if (!parsed.success) redirect("/complaints?e=invalid");
  if (!take("complaint", me.investorId)) redirect("/complaints?e=rate");
  let target = "/complaints?e=generic";
  try {
    const r = await fileComplaint(me.session, parsed.data.category, parsed.data.title, parsed.data.body);
    target = "ok" in r && r.id ? `/complaints/${String(r.id)}?ok=filed&r=${encodeURIComponent(r.ref ?? "")}` : `/complaints?e=${"error" in r ? r.error : "generic"}`;
  } catch (e) {
    logError("file complaint", e);
  }
  revalidatePath("/complaints");
  redirect(target);
}

const actSchema = z.object({
  id: z.string().regex(/^[1-9][0-9]{0,17}$/),
  action: z.enum(["reply", "close", "reopen"]),
  body: z.string().trim().max(2000).optional(),
});

export async function complaintAction(formData: FormData): Promise<void> {
  const me = await signedIn();
  const parsed = actSchema.safeParse({ id: formData.get("id"), action: formData.get("action"), body: formData.get("body") ?? undefined });
  if (!parsed.success) redirect("/complaints?e=invalid");
  const back = `/complaints/${parsed.data.id}`;
  if (!take("complaint", me.investorId)) redirect(`${back}?e=rate`);
  let target = `${back}?e=generic`;
  try {
    const r = await actOnComplaint(me.session, parsed.data.id, parsed.data.action, parsed.data.body ?? null);
    target = "ok" in r ? `${back}?ok=done` : `${back}?e=${r.error}`;
  } catch (e) {
    logError("complaint action", e);
  }
  revalidatePath(back);
  redirect(target);
}
