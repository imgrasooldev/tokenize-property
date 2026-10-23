import type { NextRequest } from "next/server";
import { buildDetail, EXIT_HEX32, LINE_KIND_CODES, paisaFromRupees, PAYEE, PAYEE_KINDS } from "@/lib/exit";
import { complianceRoute, ID, text, type Form } from "@/lib/server/compliance-route";

const SQL = "SELECT admin.exit_request($1, $2, $3, $4::jsonb, $5) AS r";
const LINE_NO = /^[1-9]\d{0,8}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const MESSAGES = new Map<string, string>([
  ["propose", "Decision proposed: it waits for the officers of each capacity."],
  ["proceeds", "Proceeds proposed: an operations checker decides them."],
  ["line", "Waterfall line added to the draft."],
  ["withdraw_line", "Waterfall line withdrawn."],
  ["submit_waterfall", "Waterfall submitted: an operations checker checks it, then a trustee officer approves it."],
  ["payment", "Payment proposed: an operations checker decides it."],
  ["announce", "Record date announced."],
]);

type Built = { args: Record<string, unknown>; reason: string | null } | string;

function build(action: string, form: Form): Built {
  const reason = text(form, "reason", 500);
  switch (action) {
    case "propose": {
      const code = text(form, "code", 3) ?? "";
      const detail = buildDetail(code, (k) => text(form, k, 200));
      if (typeof detail === "string") return detail;
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      return { args: { code, detail }, reason };
    }
    case "proceeds": {
      const kind = form?.get("kind");
      const statementId = text(form, "statementId", 18);
      const lineNo = text(form, "lineNo", 9);
      if (kind !== "deposit" && kind !== "proceeds") return "Choose deposit or proceeds.";
      if (!statementId || !ID.test(statementId) || !lineNo || !LINE_NO.test(lineNo)) return "Give the bank statement number and its credit line number.";
      if (!reason || reason.length < 5 || reason.length > 300) return "Give a note of 5 to 300 characters.";
      return { args: { kind, statementId, lineNo }, reason };
    }
    case "line": {
      const kind = text(form, "kind", 40) ?? "";
      const payee = text(form, "payee", 40)?.toLowerCase() ?? "";
      const amount = paisaFromRupees(text(form, "amount", 40));
      const evidence = text(form, "evidenceSha", 64)?.toLowerCase() ?? "";
      if (!LINE_KIND_CODES.includes(kind)) return "Choose the kind of line.";
      if (PAYEE_KINDS.includes(kind) ? !PAYEE.test(payee) : payee !== "") return "A payee id (lower-case letters, digits, - and _) is given exactly for debts, costs, payables and tenant deposits.";
      if (!amount || amount === "0") return "Give the amount in PKR.";
      if (!EXIT_HEX32.test(evidence)) return "Give the SHA-256 of the evidence (64 hex digits).";
      if (!reason || reason.length < 5 || reason.length > 300) return "Give a description of 5 to 300 characters.";
      return { args: { kind, payee, amountPaisa: amount, evidenceSha: evidence }, reason };
    }
    case "withdraw_line": {
      const lineId = text(form, "lineId", 18);
      if (!lineId || !ID.test(lineId)) return "Unknown waterfall line.";
      return { args: { lineId }, reason: null };
    }
    case "submit_waterfall":
      return { args: {}, reason: null };
    case "payment": {
      const lineId = text(form, "lineId", 18);
      const statementId = text(form, "statementId", 18);
      const lineNo = text(form, "lineNo", 9);
      if (!lineId || !ID.test(lineId)) return "Unknown waterfall line.";
      if (!statementId || !ID.test(statementId) || !lineNo || !LINE_NO.test(lineNo)) return "Give the bank statement number and its debit line number.";
      if (!reason || reason.length < 5 || reason.length > 300) return "Give a note of 5 to 300 characters.";
      return { args: { lineId, statementId, lineNo }, reason };
    }
    case "announce": {
      const recordDate = text(form, "recordDate", 10);
      const noticeSha = text(form, "noticeSha", 64)?.toLowerCase() ?? "";
      if (!recordDate || !DATE.test(recordDate)) return "Give the record date (YYYY-MM-DD).";
      if (!EXIT_HEX32.test(noticeSha)) return "Give the SHA-256 of the record-date notice (64 hex digits).";
      return { args: { recordDate, noticeSha }, reason: null };
    }
    default:
      return "Choose an action.";
  }
}

/**
 * Maker (operations) steps on one exit case: propose a decision (with its detail), attribute bank
 * credits as proceeds, draft, withdraw and submit waterfall lines, propose waterfall payments and
 * announce the record date (admin.exit_request: step-up, the officer's handle bound; every rule is
 * the database's and refusals come back audited).
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const valid = ID.test(id);
  let chosen = "";
  return complianceRoute(request, {
    permission: "exit.request",
    back: valid ? `/exit/${id}` : "/exit",
    build: (o, form) => {
      if (!valid) return "Unknown exit case.";
      const action = form?.get("action");
      if (typeof action !== "string" || !MESSAGES.has(action)) return "Choose an action.";
      const b = build(action, form);
      if (typeof b === "string") return b;
      chosen = action;
      return { sql: SQL, params: [o.sessionHash, id, action, JSON.stringify(b.args), b.reason] };
    },
    okMessage: (r) => `${MESSAGES.get(chosen) ?? "Done."} (${r.status ?? "done"})`,
  });
}
