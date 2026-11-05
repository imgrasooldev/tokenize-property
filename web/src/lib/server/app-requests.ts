import { db } from "./db";

/**
 * Reservations the mobile app asked for (ADR 0018 amendment 1, migration 0060). The investor
 * confirms them here, signed in, through the website's own reservation path; the database binds the
 * new subscription to the request only for the same investor, offering and units.
 */
export interface SubscriptionAppRequest {
  id: string;
  kind: "reserve" | "cancel" | "withdraw";
  offering_id: string;
  units: string;
  amount_paisa: string | null;
  status: string;
  code: string;
  expires_at: string;
  /** For cancel / withdraw (migration 0061): the subscription the request acts on. */
  subscription_id: string | null;
}

/** A limit order on the demo market the app asked for (migration 0062), or the cancellation of an open one (0063). */
export interface OrderAppRequest {
  id: string;
  kind: "order" | "order_cancel";
  symbol: string;
  side: "buy" | "sell";
  price_paisa: string;
  tokens: string;
  total_paisa: string;
  status: string;
  code: string;
  expires_at: string;
  /** For order_cancel (migration 0063): the investor's open order to cancel. */
  target_order_id?: string | null;
}

/** A demo cash top-up the app asked for (migration 0064). */
export interface TopUpAppRequest {
  id: string;
  kind: "topup";
  amount_paisa: string;
  status: string;
  code: string;
  expires_at: string;
}

export type AppRequest = SubscriptionAppRequest | OrderAppRequest | TopUpAppRequest;

/** A market request (place or cancel an order) rather than a subscription request. */
export function isOrderRequest(r: AppRequest): r is OrderAppRequest {
  return r.kind === "order" || r.kind === "order_cancel";
}

/** A reserve, cancel or withdraw request (the subscription kinds). */
export function isSubscriptionRequest(r: AppRequest): r is SubscriptionAppRequest {
  return r.kind === "reserve" || r.kind === "cancel" || r.kind === "withdraw";
}

export const APP_CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-?[BCDFGHJKLMNPQRSTVWXZ]{4}$/;

export async function lookupAppRequest(session: Buffer, code: string): Promise<AppRequest | null> {
  const { rows } = await (await db()).query<{ r: AppRequest | null }>("SELECT papi.web_request_lookup($1, $2) AS r", [session, code]);
  return rows[0]?.r ?? null;
}

export async function bindAppRequest(session: Buffer, code: string, subscriptionId: string): Promise<boolean> {
  const { rows } = await (await db()).query<{ r: { ok?: boolean } }>("SELECT papi.web_request_done($1, $2, $3) AS r", [session, code, subscriptionId]);
  return rows[0]?.r.ok === true;
}

export async function declineAppRequest(session: Buffer, code: string): Promise<boolean> {
  const { rows } = await (await db()).query<{ r: { ok?: boolean } }>("SELECT papi.web_request_decline($1, $2) AS r", [session, code]);
  return rows[0]?.r.ok === true;
}

/** Binds the order the website just placed to the app's order request (same investor, symbol, side, price, tokens). */
export async function bindAppOrder(session: Buffer, code: string, orderId: string): Promise<boolean> {
  const { rows } = await (await db()).query<{ r: { ok?: boolean } }>("SELECT papi.web_request_order_done($1, $2, $3) AS r", [session, code, orderId]);
  return rows[0]?.r.ok === true;
}

/**
 * After the website's own cancel or withdraw (migration 0061 PC-2): marks the app's request
 * confirmed; the database checks that the subscription really is cancelled or withdrawn.
 */
export async function finishAppRequest(session: Buffer, code: string): Promise<boolean> {
  const { rows } = await (await db()).query<{ r: { ok?: boolean } }>("SELECT papi.web_request_finish($1, $2) AS r", [session, code]);
  return rows[0]?.r.ok === true;
}

/**
 * After the website's own order cancellation (migration 0063 OC-2): marks the app's request
 * confirmed; the database checks that the target order really is cancelled.
 */
export async function finishAppOrderCancel(session: Buffer, code: string): Promise<boolean> {
  const { rows } = await (await db()).query<{ r: { ok?: boolean } }>("SELECT papi.web_request_order_cancel_done($1, $2) AS r", [session, code]);
  return rows[0]?.r.ok === true;
}

/**
 * After the website's own demo top-up (migration 0064 CT-3): marks the app's request confirmed; the
 * database checks that the top-up exists for the same investor and amount.
 */
export async function finishAppTopUp(session: Buffer, code: string): Promise<boolean> {
  const { rows } = await (await db()).query<{ r: { ok?: boolean } }>("SELECT papi.web_request_topup_done($1, $2) AS r", [session, code]);
  return rows[0]?.r.ok === true;
}
