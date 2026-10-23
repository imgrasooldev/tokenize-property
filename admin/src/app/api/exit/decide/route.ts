import type { NextRequest } from "next/server";
import { EXIT_HEX32 } from "@/lib/exit";
import { ID, text, type Form } from "@/lib/server/compliance-route";
import { exitRoute } from "@/lib/server/exit-route";

const KINDS = new Set(["vote", "conflict", "proceeds", "payment", "final", "precheck", "window", "outcome", "waterfall", "redemption"]);
const ROOT = /^0x[0-9a-f]{64}$/;

function idOf(form: Form, key: string): string | null {
  const v = text(form, key, 18);
  return v && ID.test(v) ? v : null;
}

function backOf(form: Form): string {
  const kind = form?.get("kind");
  const ref = idOf(form, "ref");
  if ((kind === "window" || kind === "outcome") && ref) return `/exit/windows/${ref}`;
  const c = idOf(form, "case");
  return c ? `/exit/${c}` : "/exit";
}

/**
 * Deciders (exit.decide): a vote on a case decision in the officer's open capacity, a conflict
 * declaration, and the maker-checker decisions on proceeds, waterfall payments, the final
 * distribution (trustee pre-check with the recomputed root, then the operations checker), the
 * waterfall and the redemption batch (operations checker checks, a trustee officer approves) and
 * redemption windows and their outcome. admin.exit_decide: step-up, reason, the digest of what was
 * shown; the database decides who may do what and returns refusals audited.
 */
export async function POST(request: NextRequest) {
  return exitRoute(request, {
    permission: "exit.decide",
    back: backOf,
    build: (o, form) => {
      const kind = form?.get("kind");
      const ref = idOf(form, "ref");
      const choice = form?.get("decision");
      const reason = text(form, "reason", 500);
      const digest = form?.get("digest");
      if (typeof kind !== "string" || !KINDS.has(kind) || !ref) return "Unknown item: reload the page.";
      if (kind === "conflict" ? choice !== "declare" : choice !== "approve" && choice !== "reject") return "Choose a decision.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      if (typeof digest !== "string" || !EXIT_HEX32.test(digest)) return "What you reviewed is missing: reload the page.";
      let args: Record<string, string> = {};
      if (kind === "precheck") {
        const root = text(form, "root", 66)?.toLowerCase() ?? "";
        if (choice === "approve" && !ROOT.test(root)) return "Give the Merkle root you recomputed (0x and 64 hex digits).";
        args = ROOT.test(root) ? { root } : {};
      }
      return {
        sql: "SELECT admin.exit_decide($1, $2, $3, $4, $5, $6, $7::jsonb) AS r",
        params: [o.sessionHash, kind, ref, choice, reason, Buffer.from(digest, "hex"), JSON.stringify(args)],
      };
    },
    okMessage: (r) => `Recorded: ${r.status ?? "done"}.`,
  });
}
