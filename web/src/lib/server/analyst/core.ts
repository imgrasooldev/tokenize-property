import { isGuardrail } from "./intents";
import { claudeAnswer, DEFAULT_MODEL } from "./providers/claude";
import { groundedAnswer } from "./providers/grounded";
import type { Answer, Intent, Question, Retrieved } from "./types";

/**
 * Provider choice (pure apart from the optional network call; no database). Guardrail intents and
 * unknown questions are always answered by the grounded provider; Claude is used only when it is
 * configured, and any failure falls back to grounded.
 */

export interface ProviderConfig {
  provider: "grounded" | "claude";
  apiKey?: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Reads ANALYST_PROVIDER, ANTHROPIC_API_KEY and ANALYST_MODEL from the backend settings map. */
export function providerConfig(env: ReadonlyMap<string, string>): ProviderConfig {
  const key = env.get("ANTHROPIC_API_KEY")?.trim();
  const wantsClaude = env.get("ANALYST_PROVIDER")?.trim() === "claude";
  const model = env.get("ANALYST_MODEL")?.trim();
  const validModel = model && /^[a-z0-9][a-z0-9.-]{2,63}$/.test(model) ? model : DEFAULT_MODEL;
  return wantsClaude && key ? { provider: "claude", apiKey: key, model: validModel } : { provider: "grounded", model: validModel };
}

export function usesClaude(intent: Intent, cfg: ProviderConfig): boolean {
  return cfg.provider === "claude" && typeof cfg.apiKey === "string" && cfg.apiKey.length > 0 && !isGuardrail(intent) && intent !== "unknown";
}

export async function composeAnswer(q: Question, intent: Intent, r: Retrieved, cfg: ProviderConfig): Promise<Answer> {
  if (usesClaude(intent, cfg) && cfg.apiKey) {
    const c = await claudeAnswer(q, intent, r, { apiKey: cfg.apiKey, model: cfg.model, fetchImpl: cfg.fetchImpl, timeoutMs: cfg.timeoutMs });
    if (c) return c;
  }
  return groundedAnswer(q, intent, r);
}
