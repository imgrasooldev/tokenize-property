import {
  exitIdempotencyKey,
  gateErrorKey,
  parseOverview,
  redemptionErrorKey,
  withdrawErrorKey,
  type ExitOverview,
  type RedemptionErrorKey,
  type RedemptionRequestInput,
  type WithdrawErrorKey,
} from "../exit-rules";
import { db } from "./db";

/**
 * The investor side of S-05 on the website (exit status, final entitlement, phase-0 redemption
 * requests). Thin client of the session-bound wrappers of migration 0027 (webauth.web_exit_overview,
 * web_redemption_request, web_redemption_withdraw), called with the website's own role (pt_web): the
 * database takes the investor and KYC subject from the session, asks for the passkey step-up and
 * enforces every rule. Nothing here decides; no money or units move.
 */

/** The signed-in investor's exit facts, or "session" when the database no longer knows the session. */
export async function exitOverview(session: Buffer): Promise<ExitOverview | "session"> {
  const { rows } = await (await db()).query<{ r: unknown }>("SELECT webauth.web_exit_overview($1) AS r", [session]);
  return parseOverview(rows[0]?.r);
}

export type RedemptionResult = { id: string; status: string; replayed: boolean } | { error: RedemptionErrorKey };

/** EX-40: lodges a request (non-binding, phase 0). The same requestId again returns the same request. */
export async function requestRedemption(session: Buffer, input: RedemptionRequestInput): Promise<RedemptionResult> {
  try {
    const { rows } = await (await db()).query<{ r: { id?: string; status?: string; replayed?: boolean; error?: string } }>(
      "SELECT webauth.web_redemption_request($1, $2::bigint, $3::numeric, $4) AS r",
      [session, input.windowId, input.units.toString(), exitIdempotencyKey(input.requestId)],
    );
    const r = rows[0]?.r;
    const gate = gateErrorKey(r);
    if (gate) return { error: gate };
    if (!r?.id) throw new Error("web_redemption_request returned nothing");
    return { id: r.id, status: r.status ?? "submitted", replayed: r.replayed === true };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (typeof err.code === "string" && /^(42501|P0002|23505|22023|23514)$/.test(err.code)) return { error: redemptionErrorKey(err.code, err.message ?? "") };
    throw e;
  }
}

export type WithdrawResult = { status: string } | { error: WithdrawErrorKey };

/** EX-44: withdraws the investor's own submitted request while its window is open. */
export async function withdrawRedemption(session: Buffer, requestId: string): Promise<WithdrawResult> {
  try {
    const { rows } = await (await db()).query<{ r: { status?: string; error?: string } }>("SELECT webauth.web_redemption_withdraw($1, $2::uuid) AS r", [session, requestId]);
    const r = rows[0]?.r;
    const gate = gateErrorKey(r);
    if (gate) return { error: gate };
    return { status: r?.status ?? "withdrawn" };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === "P0002" || err.code === "23514") return { error: withdrawErrorKey(err.code, err.message ?? "") };
    throw e;
  }
}
