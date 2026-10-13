import type { NextRequest, NextResponse } from "next/server";
import type { Permission } from "../permissions";
import { decision } from "./approvals";
import { officerMessage, pgCode } from "./db";
import { seeOther } from "./http";
import { deny, requireApi, type Officer } from "./session";

/**
 * Shared body of the database-decided approval routes (payout batches, unfreezes, S-01 requests):
 * origin + CSRF + permission (requireApi), input checks, one admin.* function call, 303 back to the
 * item's page with the outcome. The function checks session, permission and step-up again and runs
 * the backend's own decision under the officer's name; refusals come back audited.
 */
export async function decideRoute(
  request: NextRequest,
  id: string,
  opts: {
    permission: Permission;
    idPattern: RegExp;
    page: (id: string) => string;
    /** Name and pattern of the hidden field carrying what the officer reviewed. */
    reviewed: { field: string; pattern: RegExp };
    sql: string;
    params: (o: Officer, id: string, choice: "approve" | "reject", reason: string, reviewed: string) => unknown[];
  },
): Promise<NextResponse> {
  const form = await request.formData().catch(() => undefined);
  const officer = await requireApi(request, opts.permission, form);
  if (!("sessionHash" in officer)) return officer;
  if (!opts.idPattern.test(id)) return deny(400, "bad id");
  const back = (key: "ok" | "error", msg: string) => seeOther(`${opts.page(id)}?${key}=${encodeURIComponent(msg)}`);
  const choice = form?.get("decision");
  const reason = form?.get("reason");
  const reviewed = form?.get(opts.reviewed.field);
  if ((choice !== "approve" && choice !== "reject") || typeof reason !== "string" || reason.trim().length < 10 || reason.length > 500) {
    return back("error", "Give a decision and a reason of at least 10 characters.");
  }
  if (typeof reviewed !== "string" || !opts.reviewed.pattern.test(reviewed)) return back("error", "What you reviewed is missing: reload the page.");
  try {
    const r = await decision(opts.sql, opts.params(officer, id, choice, reason.trim(), reviewed));
    return r.ok ? back("ok", `Decision recorded: ${r.status ?? "done"}.`) : back("error", r.error ?? "refused");
  } catch (e) {
    if (pgCode(e) === "PTS01") return back("error", "Confirm with your security key first (step-up).");
    const msg = officerMessage(e);
    if (msg) return back("error", msg);
    throw e;
  }
}
