"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { MAX_TOPUP_PAISA, orderSchema, topUpSchema } from "@/lib/market-rules";
import { investorById, type InvestorRow } from "@/lib/server/db";
import { nudgeFollower } from "@/lib/server/follower";
import { APP_CODE, bindAppOrder, finishAppOrderCancel, lookupAppRequest } from "@/lib/server/app-requests";
import { cancelOrder, placeOrder, topUp, type PlaceError } from "@/lib/server/market";
import { logError } from "@/lib/server/log";
import { take } from "@/lib/server/rate-limit";
import { currentInvestorId, currentSession } from "@/lib/server/session";

async function signedIn(): Promise<InvestorRow> {
  const id = await currentInvestorId();
  const investor = id ? await investorById(id) : null;
  if (!investor) redirect("/login");
  return investor;
}

export interface MarketState {
  ok?: boolean;
  error?: PlaceError | "input" | "generic" | "rate";
}

export async function placeOrderAction(_prev: MarketState, formData: FormData): Promise<MarketState> {
  const investor = await signedIn();
  if (!take("order", investor.id)) return { error: "rate" };
  const parsed = orderSchema.safeParse({
    symbol: formData.get("symbol"),
    side: formData.get("side"),
    price: formData.get("price"),
    tokens: formData.get("tokens"),
    requestId: formData.get("requestId"),
  });
  if (!parsed.success) return { error: "input" };
  try {
    const r = await placeOrder(investor, parsed.data);
    if ("error" in r) return { error: r.error };
  } catch (e) {
    logError("placeOrder", e);
    return { error: "generic" };
  }
  void nudgeFollower();
  revalidatePath("/market");
  return { ok: true };
}

/**
 * Places exactly the order the mobile app asked for (ADR 0018 amendment 3, migration 0062): the
 * request is read again here by its code (never from the form), the website's own checks decide
 * (KYC, on-chain registration, band, cash or tokens, limits) and the request id is the order's
 * request id, so a repeated confirmation never places a second order. Then the order is bound.
 */
export async function confirmAppOrderAction(_prev: MarketState, formData: FormData): Promise<MarketState> {
  const session = await currentSession();
  const investor = session ? await investorById(session.investorId) : null;
  if (!session || !investor) redirect("/login");
  if (!take("order", investor.id)) return { error: "rate" };
  const code = formData.get("appCode");
  if (typeof code !== "string" || !APP_CODE.test(code)) return { error: "input" };
  const request = await lookupAppRequest(session.hash, code);
  if (request?.kind !== "order") return { error: "input" };
  let orderId: string;
  try {
    const r = await placeOrder(investor, {
      symbol: request.symbol,
      side: request.side,
      price: BigInt(request.price_paisa),
      tokens: BigInt(request.tokens),
      requestId: request.id,
    });
    if ("error" in r) return { error: r.error };
    orderId = r.orderId;
  } catch (e) {
    logError("app-order", e);
    return { error: "generic" };
  }
  void nudgeFollower();
  revalidatePath("/market");
  let bound = false;
  try {
    bound = await bindAppOrder(session.hash, code, orderId);
  } catch (e) {
    logError("app-order-bind", e);
  }
  redirect(`/confirm?${bound ? "ordered" : "orderunlinked"}=1`);
}

/**
 * Cancels an open order the mobile app asked to cancel (migration 0063): through the website's own
 * cancellation (matcher lock, buy escrow released), then the request is marked confirmed.
 */
export async function cancelAppOrderAction(formData: FormData): Promise<void> {
  const session = await currentSession();
  const investor = session ? await investorById(session.investorId) : null;
  if (!session || !investor) redirect("/login");
  if (!take("cancel", investor.id)) redirect("/confirm");
  const code = formData.get("appCode");
  if (typeof code !== "string" || !APP_CODE.test(code)) redirect("/confirm");
  const request = await lookupAppRequest(session.hash, code);
  if (request?.kind !== "order_cancel" || !request.target_order_id) redirect("/confirm");
  let finished = false;
  try {
    if (await cancelOrder(investor, request.target_order_id)) {
      revalidatePath("/market");
      finished = await finishAppOrderCancel(session.hash, code);
    }
  } catch (e) {
    logError("app-order-cancel", e);
  }
  redirect(`/confirm?${finished ? "ordercancelled" : "ordercancelfailed"}=1`);
}

export async function topUpAction(_prev: MarketState, formData: FormData): Promise<MarketState> {
  const investor = await signedIn();
  if (!take("topup", investor.id)) return { error: "rate" };
  const parsed = topUpSchema.safeParse({
    amount: formData.get("amount"),
    requestId: formData.get("requestId"),
    bankConfirm: formData.get("bankConfirm"),
  });
  if (!parsed.success || parsed.data.amount > MAX_TOPUP_PAISA) return { error: "input" };
  try {
    await topUp(investor, parsed.data.amount, parsed.data.requestId);
  } catch (e) {
    logError("topUp", e);
    return { error: "generic" };
  }
  revalidatePath("/market");
  return { ok: true };
}

const cancelSchema = z.object({ orderId: z.uuid() });

export async function cancelOrderAction(formData: FormData): Promise<void> {
  const investor = await signedIn();
  if (!take("cancel", investor.id)) return;
  const parsed = cancelSchema.safeParse({ orderId: formData.get("orderId") });
  if (parsed.success) await cancelOrder(investor, parsed.data.orderId).catch((e: unknown) => {
    logError("cancelOrder", e);
  });
  revalidatePath("/market");
}
