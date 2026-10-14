import { z } from "zod";

/**
 * Pure rules of the investor passkey screens (T-030). The database (migration 0024) decides; these
 * only check input shape early and pick the right message.
 */

/** Same rule as webauth.name_ok: 1-40 characters, no control or markup characters, no run of 6+ digits. */
export const passkeyNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine((v) => !/[\p{Cc}<>"`\\{}]/u.test(v) && !/[0-9]{6}/.test(v), "letters, numbers and spaces only");

export const passkeyRefSchema = z.uuid();

export type PasskeyError =
  | "unavailable"
  | "unsupported"
  | "cancelled"
  | "rate"
  | "session"
  | "reauth"
  | "reauthStepUp"
  | "limit"
  | "locked"
  | "busy"
  | "none"
  | "expired"
  | "verify"
  | "refused"
  | "name"
  | "duplicate"
  | "stepup"
  | "unknown"
  | "generic";

/** Codes returned by webauth.web_create_challenge / web_add_passkey / web_revoke_passkey. */
export function ceremonyError(code: string | undefined): PasskeyError {
  switch (code) {
    case "session":
    case "reauth":
    case "limit":
    case "locked":
    case "busy":
    case "none":
    case "name":
    case "duplicate":
    case "unknown":
      return code;
    case "step_up":
      return "stepup";
    case "ceremony":
      return "expired";
    case "uv":
      return "verify";
    default:
      return "generic";
  }
}

export type StepUpError = "stepup" | "enrolPasskey" | "session";

/** Maps the database's step-up decision (webauth.step_up_decision) to the website's. */
export function stepUpResult(decision: string | undefined): { ok: true } | { ok: false; error: StepUpError } {
  if (decision === "ok" || decision === "waived") return { ok: true };
  if (decision === "step_up") return { ok: false, error: "stepup" };
  if (decision === "enrol") return { ok: false, error: "enrolPasskey" };
  return { ok: false, error: "session" };
}

/** Credential IDs are base64url; anything else is refused before it reaches the database. */
export function credentialIdOk(id: unknown): id is string {
  return typeof id === "string" && id.length >= 16 && id.length <= 1366 && /^[A-Za-z0-9_-]+$/.test(id);
}

/**
 * A WebAuthn response as the browser library sends it: a small plain object with a base64url id,
 * type "public-key" and a response object. Everything else is refused before verification.
 */
export function responseShapeOk(v: unknown): v is { id: string; rawId: string; type: "public-key"; response: Record<string, unknown> } {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  if (!credentialIdOk(r.id) || r.rawId !== r.id || r.type !== "public-key") return false;
  if (r.response === null || typeof r.response !== "object" || Array.isArray(r.response)) return false;
  try {
    return JSON.stringify(v).length <= 32_768;
  } catch {
    return false;
  }
}
