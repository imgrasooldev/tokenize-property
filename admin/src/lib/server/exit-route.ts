import type { NextRequest, NextResponse } from "next/server";
import type { Permission } from "../permissions";
import { decision, type DecisionResult } from "./approvals";
import type { Form } from "./compliance-route";
import { officerMessage, pgCode } from "./db";
import { seeOther } from "./http";
import { requireApi, type Officer } from "./session";

/**
 * Body of the S-05 routes whose return page depends on the form (a decision on a case or on a
 * window): origin + CSRF + permission (requireApi), input checks, ONE admin.exit_* call, then a 303
 * back with the outcome. As complianceRoute; the database checks session, permission and step-up
 * again, binds the officer's handle and returns refusals audited ({ok: false, error}).
 */
export async function exitRoute(
  request: NextRequest,
  opts: {
    permission: Permission;
    /** Page to return to, from the (unchecked) form: must only ever build a path of this portal. */
    back: (form: Form) => string;
    build: (officer: Officer, form: Form) => { sql: string; params: unknown[] } | string;
    okPath?: (r: DecisionResult, form: Form) => string;
    okMessage: (r: DecisionResult, form: Form) => string;
  },
): Promise<NextResponse> {
  const form = await request.formData().catch(() => undefined);
  const officer = await requireApi(request, opts.permission, form);
  if (!("sessionHash" in officer)) return officer;
  const back = opts.back(form);
  const go = (path: string, key: "ok" | "error", msg: string) => seeOther(`${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(msg.slice(0, 300))}`);
  const built = opts.build(officer, form);
  if (typeof built === "string") return go(back, "error", built);
  try {
    const r = await decision(built.sql, built.params);
    return r.ok ? go(opts.okPath ? opts.okPath(r, form) : back, "ok", opts.okMessage(r, form)) : go(back, "error", r.error ?? "refused");
  } catch (e) {
    if (pgCode(e) === "PTS01") return go(back, "error", "Confirm with your security key first (step-up).");
    const msg = officerMessage(e);
    if (msg) return go(back, "error", msg);
    throw e;
  }
}
