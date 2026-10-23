import { gateError, parseTransferList, transferErrorKey, type RequestInput, type TransferErrorKey, type TransferList } from "../transfer-rules";
import { db } from "./db";

/**
 * The investor side of S-04 phase 0 transfers (spec section 16.9, migration 0028). Thin client of
 * the session-bound webauth.web_transfer* wrappers, called with the website's own role (pt_web):
 * the database takes the investor and KYC subject from the session hash, runs the passkey step-up
 * gate (transfer.request / accept / withdraw, from PKR 0) and decides every rule. Nothing here
 * decides; the website reaches no other transfer function.
 */

/** SQLSTATEs the transfer functions raise on purpose with a safe message (anything else is a fault). */
const REFUSAL = /^(42501|P0002|23514|22003)$/;

async function refusalOr<T>(run: () => Promise<T>): Promise<T | { error: TransferErrorKey }> {
  try {
    return await run();
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown };
    if (typeof err.code === "string" && REFUSAL.test(err.code)) return { error: transferErrorKey(err.code, typeof err.message === "string" ? err.message : "") };
    throw e;
  }
}

/** The signed-in investor's transfers, live receive codes and holdings; null without a valid session. */
export async function myTransfers(session: Buffer): Promise<TransferList | null> {
  const { rows } = await (await db()).query<{ r: unknown }>("SELECT webauth.web_transfers($1) AS r", [session]);
  return parseTransferList(rows[0]?.r ?? null);
}

/** A new receive code (no step-up: it only lets the investor receive). */
export async function newReceiveCode(session: Buffer): Promise<{ code: string; expiresAt: string } | { error: TransferErrorKey }> {
  return refusalOr(async () => {
    const { rows } = await (await db()).query<{ r: { code?: string; expiresAt?: string; error?: string } | null }>("SELECT webauth.web_transfer_code($1) AS r", [session]);
    const r = rows[0]?.r;
    const gate = gateError(r);
    if (gate) return { error: gate };
    if (!r?.code || !r.expiresAt) throw new Error("web_transfer_code returned nothing");
    return { code: r.code, expiresAt: r.expiresAt };
  });
}

/** The seller's request to the holder of a receive code (step-up transfer.request). */
export async function requestTransfer(session: Buffer, input: RequestInput): Promise<{ id: string } | { error: TransferErrorKey }> {
  return refusalOr(async () => {
    const { rows } = await (await db()).query<{ r: { ok?: boolean; id?: string; error?: string } | null }>(
      "SELECT webauth.web_transfer_request($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) AS r",
      [
        session,
        input.token,
        input.units.toString(),
        input.buyerCode,
        input.consideration,
        input.pricePaisa === null ? null : input.pricePaisa.toString(),
        input.noPriceReason,
        input.agreementSha256,
        input.priceExplanation,
        input.holdingReason,
      ],
    );
    const r = rows[0]?.r;
    const gate = gateError(r);
    if (gate) return { error: gate };
    if (!r?.ok || !r.id) throw new Error("web_transfer_request returned nothing");
    return { id: r.id };
  });
}

/** The buyer accepts with the SAME agreement fingerprint as the seller (step-up transfer.accept). */
export async function acceptTransfer(session: Buffer, caseId: string, agreementSha256: string): Promise<{ status: string } | { error: TransferErrorKey }> {
  return refusalOr(async () => {
    const { rows } = await (await db()).query<{ r: { ok?: boolean; status?: string; error?: string } | null }>("SELECT webauth.web_transfer_accept($1, $2, $3) AS r", [
      session,
      caseId,
      agreementSha256,
    ]);
    const r = rows[0]?.r;
    const gate = gateError(r);
    if (gate) return { error: gate };
    return { status: r?.status ?? "unknown" };
  });
}

/** Either party withdraws before any payment is booked (step-up transfer.withdraw). */
export async function withdrawTransfer(session: Buffer, caseId: string): Promise<{ status: string } | { error: TransferErrorKey }> {
  return refusalOr(async () => {
    const { rows } = await (await db()).query<{ r: { ok?: boolean; status?: string; error?: string } | null }>("SELECT webauth.web_transfer_withdraw($1, $2) AS r", [session, caseId]);
    const r = rows[0]?.r;
    const gate = gateError(r);
    if (gate) return { error: gate };
    return { status: r?.status ?? "unknown" };
  });
}
