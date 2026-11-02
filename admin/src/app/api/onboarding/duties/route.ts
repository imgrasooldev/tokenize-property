import type { NextRequest } from "next/server";
import { complianceRoute, ID, text, UUID } from "@/lib/server/compliance-route";
import { DUTIES } from "@/lib/server/onboarding";

/**
 * Administrators (migration 0049 PO-2): S-01 duties of officers (request, decide, revoke) and the
 * valuer panel (add, approve). One administrator asks, a different one decides or approves; the
 * duty must fit a role the officer holds (admin.duty_roles). Returns to /officers.
 */
const HANDLE = /^[a-z][a-z0-9._-]{2,39}$/;

export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "officers.manage",
    back: "/officers",
    build: (o, form) => {
      const action = form?.get("action");
      const reason = text(form, "reason", 500);
      const id = text(form, "id", 20);
      if (action === "request_duty") {
        const officer = text(form, "officer", 40);
        const duty = text(form, "duty", 30);
        if (!officer || !HANDLE.test(officer)) return "Choose an officer.";
        if (!duty || !(DUTIES as readonly string[]).includes(duty)) return "Choose a duty.";
        if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
        return { sql: "SELECT admin.property_act($1, 'request_duty', $2::jsonb) AS r", params: [o.sessionHash, JSON.stringify({ officer, duty, reason })] };
      }
      if (action === "approve_duty" || action === "reject_duty" || action === "revoke_duty") {
        if (!id || !ID.test(id)) return "Choose a duty.";
        if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
        return action === "revoke_duty"
          ? { sql: "SELECT admin.property_act($1, 'revoke_duty', $2::jsonb) AS r", params: [o.sessionHash, JSON.stringify({ id, reason })] }
          : { sql: "SELECT admin.property_act($1, 'decide_duty', $2::jsonb) AS r", params: [o.sessionHash, JSON.stringify({ id, approve: action === "approve_duty", reason })] };
      }
      if (action === "add_valuer") {
        const licence = text(form, "licence", 40);
        const panel = text(form, "panel", 31);
        const subject = text(form, "subject", 36);
        if (!licence) return "Give the valuer's licence number.";
        if (!panel || !/^[a-z][a-z0-9_]{1,30}$/.test(panel)) return "Give the panel (lower case letters, digits, _).";
        if (subject && !UUID.test(subject)) return "The KYC subject id is not valid.";
        return { sql: "SELECT admin.property_act($1, 'add_valuer', $2::jsonb) AS r", params: [o.sessionHash, JSON.stringify({ licence, panel, ...(subject ? { subject } : {}) })] };
      }
      if (action === "approve_valuer") {
        if (!id || !ID.test(id)) return "Choose a valuer.";
        return { sql: "SELECT admin.property_act($1, 'approve_valuer', $2::jsonb) AS r", params: [o.sessionHash, JSON.stringify({ id })] };
      }
      return "Choose an action.";
    },
    okMessage: (r) => `Done${typeof r.result === "string" || typeof r.result === "number" || typeof r.result === "boolean" ? `: ${String(r.result)}` : ""}.`,
  });
}
