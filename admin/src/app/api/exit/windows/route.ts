import type { NextRequest } from "next/server";
import { EXIT_ADDRESS, EXIT_HEX32, paisaFromRupees, pktLocalToUtc } from "@/lib/exit";
import { ID, text, type Form } from "@/lib/server/compliance-route";
import { exitRoute } from "@/lib/server/exit-route";

const SQL = "SELECT admin.exit_request($1, NULL, $2, $3::jsonb, $4) AS r";
const PPM = /^(0|[1-9]\d{0,6})$/;

function windowOf(form: Form): string | null {
  const id = text(form, "windowId", 18);
  return id && ID.test(id) ? id : null;
}

/**
 * Maker (operations) actions on redemption windows (S-05 section 15): propose a window (token,
 * opening and closing time, NAV per unit with its evidence, discount) and, once it has closed,
 * propose its outcome (admin.exit_request 'window' / 'outcome', p_case NULL: step-up, handle bound).
 */
export async function POST(request: NextRequest) {
  return exitRoute(request, {
    permission: "exit.request",
    back: (form) => {
      const id = form?.get("action") === "outcome" ? windowOf(form) : null;
      return id ? `/exit/windows/${id}` : "/exit";
    },
    build: (o, form) => {
      const action = form?.get("action");
      if (action === "outcome") {
        const windowId = windowOf(form);
        if (!windowId) return "Unknown redemption window.";
        return { sql: SQL, params: [o.sessionHash, "outcome", JSON.stringify({ windowId }), null] };
      }
      if (action !== "window") return "Choose an action.";
      const token = text(form, "token", 42)?.toLowerCase() ?? null;
      const opensAt = pktLocalToUtc(text(form, "opensAt", 16));
      const closesAt = pktLocalToUtc(text(form, "closesAt", 16));
      const nav = paisaFromRupees(text(form, "nav", 40));
      const navSha = text(form, "navSha", 64)?.toLowerCase() ?? "";
      const discount = text(form, "discountPpm", 7) ?? "0";
      const note = text(form, "reason", 300);
      if (!token || !EXIT_ADDRESS.test(token)) return "Give the token address.";
      if (!opensAt || !closesAt) return "Give the opening and closing time (PKT).";
      if (!nav || nav === "0") return "Give the NAV per unit in PKR.";
      if (!EXIT_HEX32.test(navSha)) return "Give the SHA-256 of the NAV valuation evidence (64 hex digits).";
      if (!PPM.test(discount)) return "Give the discount in ppm (0 to 200000).";
      if (!note || note.length < 10) return "Give a note of 10 to 300 characters.";
      return {
        sql: SQL,
        params: [o.sessionHash, "window", JSON.stringify({ token, opensAt, closesAt, navPerUnitPaisa: nav, navSha, discountPpm: Number(discount) }), note],
      };
    },
    okPath: (r, form) => (form?.get("action") === "window" && r.id ? `/exit/windows/${String(r.id)}` : `/exit/windows/${windowOf(form) ?? ""}`),
    okMessage: (r, form) =>
      form?.get("action") === "window" ? "Redemption window proposed: an operations checker decides it." : `Outcome ${r.status ?? "proposed"}: an operations checker decides it.`,
  });
}
