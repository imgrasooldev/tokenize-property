import { keccak256, stringToBytes, type Hex } from "viem";
import type { LedgerJournal } from "./types.ts";

/**
 * How ledger journals name the business events reconciliation links to the chain (ADR 0007).
 * Producers must follow these keys; anything else is not linked (and shows up as a finding where a
 * link is required).
 *
 * Subscriptions (threat M-6), one subscription = one refId on chain:
 *   web:sub:<uuid>:paid|settled|refunded   web prototype (refId = keccak256("property-token:subscription:<uuid>"))
 *   sub:<refId>:paid|settled|refunded      backend services (5g onwards)
 *   paid      money in: debits a bank account, external_ref = the bank (Raast) reference
 *   settled   tokens confirmed on chain (external_ref = mint transaction)
 *   refunded  money back: credits the bank account, external_ref = the bank reference
 *
 * Rent (threat M-2), one distribution = (token, id) in the DistributionRegistry:
 *   rent:distribution:<token>:<id>   booked when the distribution is finalized; external_ref = statement hash
 *   rent:payout:<token>:<id>         the bank payout batch; credits the bank account; external_ref = batch reference
 *   On chain, recordPayout(id, payoutBatchHash) with payoutBatchHash = keccak256(utf8(batch reference)) for the
 *   mock bank; the real bank's batch-file hash replaces this in Step 5g.
 */

export type SubscriptionPhase = "paid" | "settled" | "refunded";

const WEB_SUB = /^web:sub:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(paid|settled|refunded)$/;
const BACKEND_SUB = /^sub:(0x[0-9a-f]{64}):(paid|settled|refunded)$/;
const RENT = /^rent:(distribution|payout):(0x[0-9a-f]{40}):([1-9][0-9]{0,30})$/;

/** Same derivation as web/src/lib/invest-rules.ts refIdFor (kept in sync by a test). */
export function refIdForSubscription(subscriptionId: string): Hex {
  return keccak256(stringToBytes(`property-token:subscription:${subscriptionId}`));
}

/** Mock bank convention for DistributionRegistry.recordPayout. */
export function payoutBatchHash(reference: string): Hex {
  return keccak256(stringToBytes(reference));
}

export function parseSubscriptionKey(key: string): { refId: string; phase: SubscriptionPhase } | null {
  const web = WEB_SUB.exec(key);
  if (web?.[1] && web[2]) return { refId: refIdForSubscription(web[1]), phase: web[2] as SubscriptionPhase };
  const backend = BACKEND_SUB.exec(key);
  if (backend?.[1] && backend[2]) return { refId: backend[1], phase: backend[2] as SubscriptionPhase };
  return null;
}

export function parseRentKey(key: string): { what: "distribution" | "payout"; token: string; id: bigint } | null {
  const m = RENT.exec(key);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  return { what: m[1] as "distribution" | "payout", token: m[2], id: BigInt(m[3]) };
}

/** The amount a journal moves: the sum of its debits (it balances, so it also equals its credits). */
export function journalTotal(j: LedgerJournal): bigint {
  return j.postings.reduce((s, p) => (p.amount > 0n ? s + p.amount : s), 0n);
}

const PKT_OFFSET_MS = 5 * 3_600_000; // Pakistan Standard Time, UTC+5, no daylight saving

/** Start of a PKT business day (YYYY-MM-DD) as an instant. */
export function dayStart(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1) - PKT_OFFSET_MS);
}

/** End (exclusive) of a PKT business day. */
export function dayEnd(date: string): Date {
  return new Date(dayStart(date).getTime() + 86_400_000);
}

/** The PKT business day an instant falls on. */
export function pktDate(at: Date): string {
  return new Date(at.getTime() + PKT_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return pktDate(new Date(dayStart(date).getTime() + days * 86_400_000));
}
