"use server";

import { z } from "zod";
import { answer, type Answer } from "@/lib/server/analyst";
import { rateLimitedAnswer } from "@/lib/server/analyst/providers/grounded";
import { investorById } from "@/lib/server/db";
import { getLang } from "@/lib/server/lang";
import { logError } from "@/lib/server/log";
import { clientKey, take } from "@/lib/server/rate-limit";
import { currentInvestorId } from "@/lib/server/session";

export interface AskState {
  answer?: Answer;
  error?: "input" | "signin" | "failed";
  /** The question as asked (to show it back after the form resets). */
  question?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const askInput = z.object({
  question: z.string().trim().min(2).max(300),
  scope: z.enum(["site", "property", "portfolio"]),
  propertyKey: z
    .string()
    .refine((k) => /^[A-Z][A-Z0-9]{2,11}$/.test(k) || UUID.test(k))
    .optional(),
  lang: z.enum(["en", "ur"]).optional(),
});

/**
 * Property analyst question (ADR 0015). Public for site and property questions; portfolio questions
 * need a signed-in investor and see only that investor's own figures. Rate limited ("ask"), keyed by
 * investor id when signed in, else by client address. The question text is never logged or stored.
 */
export async function askAction(_prev: AskState, formData: FormData): Promise<AskState> {
  const str = (k: string): string | undefined => {
    const v = formData.get(k);
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  const parsed = askInput.safeParse({ question: str("question") ?? "", scope: str("scope") ?? "site", propertyKey: str("propertyKey"), lang: str("lang") });
  if (!parsed.success) return { error: "input" };
  const { question, scope, propertyKey } = parsed.data;
  const lang = parsed.data.lang ?? (await getLang());

  const investorId = await currentInvestorId();
  const investor = investorId ? await investorById(investorId).catch(() => null) : null;
  if (scope === "portfolio" && !investor) return { error: "signin", question };

  if (!take("ask", investor ? `investor:${investor.id}` : `client:${await clientKey()}`)) {
    return { answer: rateLimitedAnswer({ lang }, new Date().toISOString()), question };
  }
  try {
    const a = await answer({ text: question, lang, scope, ...(propertyKey ? { propertyKey } : {}) }, { investor });
    return { answer: a, question };
  } catch (e) {
    logError("analyst", e instanceof Error ? e.name : "Error");
    return { error: "failed", question };
  }
}
