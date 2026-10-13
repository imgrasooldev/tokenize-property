import type { NextRequest, NextResponse } from "next/server";
import type { Permission } from "../permissions";
import { decision, type DecisionResult } from "./approvals";
import { officerMessage, pgCode } from "./db";
import { seeOther } from "./http";
import { requireApi, type Officer } from "./session";

/**
 * Shared body of the Step 6c compliance routes: origin + CSRF + permission (requireApi), input
 * checks, ONE admin.* function call, then a 303 back to a page with the outcome. The database
 * function checks the session, the permission and (for decisions) a step-up younger than five
 * minutes again, binds the officer's handle and returns refusals audited ({ok: false, error}).
 * Nothing personal travels in the redirect: only ids and the officer-facing message.
 */
export const ID = /^[1-9]\d{0,17}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const HEX32 = /^[0-9a-f]{64}$/;

export type Form = FormData | undefined;

export function text(form: Form, key: string, max: number): string | null {
  const v = form?.get(key);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 && t.length <= max ? t : null;
}

export async function complianceRoute(
  request: NextRequest,
  opts: {
    permission: Permission;
    /** Page to return to (also on refusal). */
    back: string;
    /** Either an error message for the officer, or the SQL and its parameters. */
    build: (officer: Officer, form: Form) => { sql: string; params: unknown[] } | string;
    /** Where to go after success (default: back). */
    okPath?: (r: DecisionResult) => string;
    okMessage: (r: DecisionResult) => string;
  },
): Promise<NextResponse> {
  const form = await request.formData().catch(() => undefined);
  const officer = await requireApi(request, opts.permission, form);
  if (!("sessionHash" in officer)) return officer;
  const go = (path: string, key: "ok" | "error", msg: string) => seeOther(`${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(msg.slice(0, 300))}`);
  const built = opts.build(officer, form);
  if (typeof built === "string") return go(opts.back, "error", built);
  try {
    const r = await decision(built.sql, built.params);
    return r.ok ? go(opts.okPath ? opts.okPath(r) : opts.back, "ok", opts.okMessage(r)) : go(opts.back, "error", r.error ?? "refused");
  } catch (e) {
    if (pgCode(e) === "PTS01") return go(opts.back, "error", "Confirm with your security key first (step-up).");
    const msg = officerMessage(e);
    if (msg) return go(opts.back, "error", msg);
    throw e;
  }
}
