import type { NextRequest } from "next/server";
import { complianceRoute, text } from "@/lib/server/compliance-route";

/** Maker: propose a token-holder poll (admin.propose_poll, migration 0046); a trustee officer approves it. */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "operations.request",
    back: "/votes",
    build: (o, form) => {
      const token = form?.get("token");
      const title = text(form, "title", 120);
      const question = text(form, "question", 1000);
      const options = (text(form, "options", 600) ?? "")
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean);
      const block = form?.get("recordBlock");
      const opens = form?.get("opens");
      const closes = form?.get("closes");
      const quorum = form?.get("quorum");
      if (typeof token !== "string" || !/^0x[0-9a-f]{40}$/.test(token)) return "Choose a token.";
      if (!title || !question) return "Give a title and a question.";
      if (options.length < 2 || options.length > 6) return "Give 2 to 6 options, one per line.";
      if (typeof block !== "string" || !/^[1-9]\d{0,15}$/.test(block)) return "Give the record block.";
      if (typeof opens !== "string" || typeof closes !== "string" || Number.isNaN(Date.parse(opens)) || Number.isNaN(Date.parse(closes))) return "Give the opening and closing times.";
      if (typeof quorum !== "string" || !/^\d{1,3}$/.test(quorum) || Number(quorum) > 100) return "The quorum is 0 to 100 %.";
      return {
        sql: "SELECT admin.propose_poll($1, $2, $3, $4, $5::text[], $6, $7::timestamptz, $8::timestamptz, $9) AS r",
        params: [o.sessionHash, token, title, question, options, block, new Date(opens).toISOString(), new Date(closes).toISOString(), Number(quorum) * 10_000],
      };
    },
    okMessage: (r) => `Poll #${String(r.id ?? "")} proposed: a trustee officer approves it before it opens.`,
  });
}
