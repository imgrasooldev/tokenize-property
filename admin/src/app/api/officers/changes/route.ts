import type { NextRequest } from "next/server";
import { z } from "zod";
import { db, officerMessage } from "@/lib/server/db";
import { seeOther } from "@/lib/server/http";
import { requireApi } from "@/lib/server/session";
import { ROLES } from "@/lib/permissions";

const schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("invite"),
    newHandle: z.string().trim().regex(/^[a-z][a-z0-9._-]{2,39}$/, "handle: 3-40 lower-case letters, digits, . _ -"),
    newName: z
      .string()
      .trim()
      .min(2)
      .max(80)
      .regex(/^[\p{L}][\p{L} .'-]*$/u, "name: letters and spaces only"),
    role: z.enum(ROLES),
    reason: z.string().trim().min(10, "reason: at least 10 characters").max(500),
  }),
  z.object({ kind: z.enum(["grant", "revoke"]), officer: z.uuid(), role: z.enum(ROLES), reason: z.string().trim().min(10).max(500) }),
  z.object({ kind: z.literal("disable"), officer: z.uuid(), reason: z.string().trim().min(10).max(500) }),
]);

/** Maker: an administrator asks for an officer change; a different administrator decides it. */
export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => undefined);
  const officer = await requireApi(request, "officers.manage", form);
  if (!("sessionHash" in officer)) return officer;
  const parsed = schema.safeParse({
    kind: form?.get("kind"),
    newHandle: form?.get("newHandle") ?? undefined,
    newName: form?.get("newName") ?? undefined,
    officer: form?.get("officer") ?? undefined,
    role: form?.get("role") || undefined,
    reason: form?.get("reason"),
  });
  if (!parsed.success) {
    return seeOther(`/officers?error=${encodeURIComponent(parsed.error.issues[0]?.message ?? "invalid request")}`);
  }
  const d = parsed.data;
  try {
    const { rows } = await db().query<{ id: string }>("SELECT admin.request_change($1, $2, $3, $4, $5, $6, $7) AS id", [
      officer.sessionHash,
      d.kind,
      d.kind === "invite" ? null : d.officer,
      d.kind === "disable" ? null : d.role,
      d.kind === "invite" ? d.newHandle : null,
      d.kind === "invite" ? d.newName : null,
      d.reason,
    ]);
    return seeOther(`/officers?ok=${encodeURIComponent(`Change #${rows[0]?.id ?? "?"} requested: another administrator must approve it.`)}`);
  } catch (e) {
    const msg = officerMessage(e);
    if (msg) return seeOther(`/officers?error=${encodeURIComponent(msg)}`);
    throw e;
  }
}
