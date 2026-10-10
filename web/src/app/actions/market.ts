"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { MAX_TOPUP_PAISA, orderSchema, topUpSchema } from "@/lib/market-rules";
import { investorById, type InvestorRow } from "@/lib/server/db";
import { cancelOrder, placeOrder, topUp, type PlaceError } from "@/lib/server/market";
import { currentInvestorId } from "@/lib/server/session";

async function signedIn(): Promise<InvestorRow> {
  const id = await currentInvestorId();
  const investor = id ? await investorById(id) : null;
  if (!investor) redirect("/login");
  return investor;
}

export interface MarketState {
  ok?: boolean;
  error?: PlaceError | "input" | "generic";
}

export async function placeOrderAction(_prev: MarketState, formData: FormData): Promise<MarketState> {
  const investor = await signedIn();
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
  } catch {
    return { error: "generic" };
  }
  revalidatePath("/market");
  return { ok: true };
}

export async function topUpAction(_prev: MarketState, formData: FormData): Promise<MarketState> {
  const investor = await signedIn();
  const parsed = topUpSchema.safeParse({
    amount: formData.get("amount"),
    requestId: formData.get("requestId"),
    bankConfirm: formData.get("bankConfirm"),
  });
  if (!parsed.success || parsed.data.amount > MAX_TOPUP_PAISA) return { error: "input" };
  try {
    await topUp(investor, parsed.data.amount, parsed.data.requestId);
  } catch {
    return { error: "generic" };
  }
  revalidatePath("/market");
  return { ok: true };
}

const cancelSchema = z.object({ orderId: z.uuid() });

export async function cancelOrderAction(formData: FormData): Promise<void> {
  const investor = await signedIn();
  const parsed = cancelSchema.safeParse({ orderId: formData.get("orderId") });
  if (parsed.success) await cancelOrder(investor, parsed.data.orderId);
  revalidatePath("/market");
}
