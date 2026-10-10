import { keccak256, stringToBytes, type Hex } from "viem";
import { z } from "zod";
import type { Property } from "./properties";

/** Smallest order, in tokens. */
export const MIN_TOKENS = 10n;

/**
 * Most tokens one investor identity may hold: 10% of the 1,000,000-unit trustee register
 * (contract-spec §4.3, MaxBalanceModule). Checked here for a clear message; the token's compliance
 * module enforces it on chain regardless.
 */
export const MAX_HOLDING_TOKENS = 100_000n;

export const investSchema = z.object({
  symbol: z.string().regex(/^[A-Z][A-Z0-9]{2,11}$/),
  tokens: z
    .string()
    .trim()
    .regex(/^[1-9][0-9]{0,6}$/, "whole number of tokens")
    .transform((s) => BigInt(s)),
  requestId: z.uuid({ version: "v4" }),
  bankConfirm: z.literal("on", "confirm the Raast payment"),
});

/** Price of an order in paisa (PKR × 100), exact integer arithmetic. */
export function quotePaisa(p: Pick<Property, "navPkr">, tokens: bigint): bigint {
  if (!Number.isInteger(p.navPkr) || p.navPkr <= 0) throw new Error("price must be a positive whole number of rupees");
  return tokens * BigInt(p.navPkr) * 100n;
}

export type OrderProblem = "min" | "maxHolding" | "cap" | "paused";

/** Off-chain pre-checks for an order. The contracts repeat every one of them. */
export function checkOrder(o: {
  tokens: bigint;
  holding: bigint;
  supply: bigint;
  cap: bigint;
  paused: boolean;
}): OrderProblem | null {
  if (o.paused) return "paused";
  if (o.tokens < MIN_TOKENS) return "min";
  if (o.holding + o.tokens > MAX_HOLDING_TOKENS) return "maxHolding";
  if (o.supply + o.tokens > o.cap) return "cap";
  return null;
}

/** IssuanceGuard refId for a subscription: deterministic, never zero, unique per subscription. */
export function refIdFor(subscriptionId: string): Hex {
  return keccak256(stringToBytes(`property-token:subscription:${subscriptionId}`));
}

/** Formats paisa as rupees with two decimals, without floating point. */
export function paisaToRupees(paisa: bigint): string {
  const sign = paisa < 0n ? "-" : "";
  const abs = paisa < 0n ? -paisa : paisa;
  return `${sign}${(abs / 100n).toLocaleString("en-PK")}.${(abs % 100n).toString().padStart(2, "0")}`;
}
