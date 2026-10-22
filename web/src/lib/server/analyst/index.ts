import type { Lang } from "../../i18n";
import { backendEnv, type InvestorRow } from "../db";
import { composeAnswer, providerConfig, type ProviderConfig } from "./core";
import { detectIntent } from "./intents";
import { signInAnswer } from "./providers/grounded";
import { retrieveFacts } from "./retrieve";
import type { Answer, Question } from "./types";

/**
 * Property analyst entry point (ADR 0015). Order: detect the intent (guardrails first), read the
 * facts from records, then compose the answer with the configured provider (grounded by default;
 * Claude only when the owner configured it, never for guardrail intents). Every answer carries the
 * disclaimer "Informational, not investment advice".
 */

export type { Answer, CitedFact, Fact, Intent, Question, Scope, Source } from "./types";
export { detectIntent } from "./intents";

export interface AnswerContext {
  /** The signed-in investor (portfolio questions); null when signed out. */
  investor: InvestorRow | null;
  /** True for page renders (search page, portfolio summary): never call an external service. */
  groundedOnly?: boolean;
}

function config(groundedOnly: boolean): ProviderConfig {
  const cfg = providerConfig(backendEnv());
  return groundedOnly ? { provider: "grounded", model: cfg.model } : cfg;
}

export async function answer(question: Question, ctx: AnswerContext): Promise<Answer> {
  const intent = detectIntent(question.text, question.scope);
  const r = await retrieveFacts(question, intent, ctx.investor);
  if (r === "signin") return signInAnswer(question, new Date().toISOString());
  return composeAnswer(question, intent, r, config(ctx.groundedOnly === true));
}

/** Grounded "my portfolio" answer for the signed-in investor (rendered without a click). */
export async function portfolioSummary(investor: InvestorRow, lang: Lang): Promise<Answer> {
  return answer({ text: "my portfolio", lang, scope: "portfolio" }, { investor, groundedOnly: true });
}
