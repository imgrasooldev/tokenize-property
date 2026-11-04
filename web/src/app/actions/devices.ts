"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { decideDevice, removeDevice } from "@/lib/server/devices";
import { logError } from "@/lib/server/log";
import { take } from "@/lib/server/rate-limit";
import { currentSession } from "@/lib/server/session";

/** Approves or denies the code the mobile app shows (ADR 0018); passkey step-up first where the investor has one. */
const schema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-?[BCDFGHJKLMNPQRSTVWXZ]{4}$/),
  decision: z.enum(["approve", "deny"]),
});

export interface DeviceState {
  ok?: "approved" | "denied";
  deviceName?: string;
  error?: "input" | "rate" | "code" | "generic" | "stepup" | "enrolPasskey";
}

export async function deviceAction(_prev: DeviceState, formData: FormData): Promise<DeviceState> {
  const s = await currentSession();
  if (!s) redirect("/login");
  const parsed = schema.safeParse({ code: formData.get("code"), decision: formData.get("decision") });
  if (!parsed.success) return { error: "input" };
  if (!take("transfer", s.investorId)) return { error: "rate" };
  try {
    const r = await decideDevice(s.hash, parsed.data.code.replace("-", ""), parsed.data.decision);
    if ("error" in r) return { error: r.error === "session" || r.error === "input" ? "generic" : r.error };
    revalidatePath("/account");
    return { ok: parsed.data.decision === "approve" ? "approved" : "denied", deviceName: r.deviceName };
  } catch (e) {
    logError("device decide", e);
    return { error: "generic" };
  }
}

const removeSchema = z.object({ family: z.uuid() });

export async function removeDeviceAction(formData: FormData): Promise<void> {
  const s = await currentSession();
  if (!s) redirect("/login");
  const parsed = removeSchema.safeParse({ family: formData.get("family") });
  if (parsed.success) await removeDevice(s.hash, parsed.data.family);
  revalidatePath("/account");
}
