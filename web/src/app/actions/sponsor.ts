"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { PROPERTY_DOCS, SPONSOR_DOCS } from "@/lib/i18n-sponsor";
import { logError } from "@/lib/server/log";
import { take } from "@/lib/server/rate-limit";
import { currentSession } from "@/lib/server/session";
import { sponsorAct, sponsorUpload, type SponsorAction, type SponsorResult } from "@/lib/server/sponsor";

/**
 * Sponsor portal actions (migration 0048). Plain forms; the database checks that the signed-in
 * person represents the sponsor, has the power and that the file's state allows it.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID_FIELDS = ["province", "district", "society", "plot_no", "mauza", "khasra", "building", "sub_registrar", "deed_no", "deed_date", "land_record_ref", "excise_no", "land_area", "land_area_unit", "gps_lat", "gps_lon", "use", "occupancy"] as const;

async function signedIn(): Promise<{ investorId: string; session: Buffer }> {
  const s = await currentSession();
  if (!s) redirect("/login");
  return { investorId: s.investorId, session: s.hash };
}

function finish(r: SponsorResult): never {
  revalidatePath("/sponsor");
  redirect("ok" in r ? "/sponsor?ok=1" : `/sponsor?e=${r.error}`);
}

function identifiers(form: FormData): Record<string, string | boolean> {
  const ids = new Map<string, string | boolean>();
  for (const k of ID_FIELDS) {
    const v = form.get(k);
    if (typeof v === "string" && v.trim() !== "") ids.set(k, v.trim());
  }
  const built = form.get("built");
  if (built === "yes" || built === "no") ids.set("built", built === "yes");
  return Object.fromEntries(ids);
}

const actSchema = z.object({
  action: z.enum(["submit_kyb", "create_property", "update_property", "submit_property", "withdraw_property"]),
  sponsor: z.string().regex(UUID).optional(),
  property: z.string().regex(UUID).optional(),
  reason: z.string().trim().max(500).optional(),
});

export async function sponsorAction(form: FormData): Promise<void> {
  const me = await signedIn();
  const p = actSchema.safeParse({
    action: form.get("action"),
    sponsor: form.get("sponsor") ?? undefined,
    property: form.get("property") ?? undefined,
    reason: form.get("reason") ?? undefined,
  });
  if (!p.success) redirect("/sponsor?e=invalid");
  if (!take("transfer", me.investorId)) redirect("/sponsor?e=rate");
  const action: SponsorAction = p.data.action;
  let r: SponsorResult = { error: "invalid" };
  try {
    r = await sponsorAct(me.session, {
      sponsor: p.data.sponsor ?? null,
      property: p.data.property ?? null,
      action,
      ...(action === "create_property" || action === "update_property" ? { ids: identifiers(form) } : {}),
      ...(p.data.reason ? { reason: p.data.reason } : {}),
    });
  } catch (e) {
    logError("sponsor action", e);
    redirect("/sponsor?e=generic");
  }
  finish(r);
}

const MEDIA = new Set(["application/pdf", "image/jpeg", "image/png", "image/tiff"]);
const uploadSchema = z.object({
  sponsor: z.string().regex(UUID),
  property: z.string().regex(UUID).optional(),
  type: z.enum([...SPONSOR_DOCS, ...PROPERTY_DOCS]),
});

export async function sponsorUploadAction(form: FormData): Promise<void> {
  const me = await signedIn();
  const p = uploadSchema.safeParse({ sponsor: form.get("sponsor"), property: form.get("property") ?? undefined, type: form.get("type") });
  const file = form.get("file");
  if (!p.success || !(file instanceof File) || file.size === 0 || file.size > 25 * 1024 * 1024 || !MEDIA.has(file.type)) redirect("/sponsor?e=invalid");
  if (!take("transfer", me.investorId)) redirect("/sponsor?e=rate");
  let r: SponsorResult = { error: "invalid" };
  try {
    r = await sponsorUpload(me.session, { sponsor: p.data.sponsor, property: p.data.property ?? null, type: p.data.type, media: file.type, bytes: Buffer.from(await file.arrayBuffer()) });
  } catch (e) {
    logError("sponsor upload", e);
    redirect("/sponsor?e=generic");
  }
  finish(r);
}
