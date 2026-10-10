import { randomBytes, randomUUID } from "node:crypto";
import type { Address, Hex } from "viem";
import { issuanceGuardAbi, tokenAbi } from "../abis";
import { checkOrder, quotePaisa, refIdFor, type OrderProblem } from "../invest-rules";
import { findProperty } from "../properties";
import { latestDeployment, liveToken } from "./chain";
import { db, type InvestorRow } from "./db";
import { NotSentError, platformAccount, publicClient, RevertedError, send, waitSuccess } from "./demo-signer";
import { openAccount, postJournal } from "./ledger";
import { isVerifiedOnChain } from "./onboarding";

/**
 * W3 invest flow: mock Raast payment → ledger → real mint → ledger settlement.
 *
 * Safety rules:
 * - Money is recorded in the ledger BEFORE any token is minted, and every journal has an
 *   idempotency key, so a retry can never charge or settle twice.
 * - Each subscription has a single-use IssuanceGuard refId, so it can never mint twice (I-11).
 * - A refund is posted only when the mint provably never happened: refused before broadcast, or
 *   mined and reverted. If the outcome is unknown (timeout, RPC error), the subscription goes to
 *   "review" and is settled later only once the chain shows the refId as used.
 */

export type InvestError = OrderProblem | "unverified" | "notLive" | "chain" | "generic";

export type SubscriptionStatus = "paid" | "minting" | "done" | "refunded" | "review";

export interface SubscriptionRow {
  id: string;
  request_id: string;
  investor_id: string;
  symbol: string;
  tokens: string;
  amount_paisa: string;
  bank_ref: string;
  ref_id: Hex;
  status: SubscriptionStatus;
  mint_tx: Hex | null;
  note: string | null;
  created_at: Date;
  updated_at: Date;
}

const BANK = "web:bank:subscriptions";
const investorAccount = (investorId: string) => `web:investor:${investorId}:subscription`;
const capitalAccount = (symbol: string) => `web:property:${symbol.toLowerCase()}:capital`;
const BY = "web-prototype";

export async function placeOrder(
  investor: InvestorRow,
  input: { symbol: string; tokens: bigint; requestId: string },
): Promise<{ subscriptionId: string } | { error: InvestError }> {
  const p = findProperty(input.symbol);
  if (p?.status !== "live") return { error: "notLive" };
  if (investor.kyc_status !== "verified" || (await isVerifiedOnChain(investor.wallet_address)) !== true) {
    return { error: "unverified" };
  }
  const live = await liveToken(p.symbol);
  if (!live) return { error: "chain" };
  const holding = await publicClient
    .readContract({ address: live.address, abi: tokenAbi, functionName: "balanceOf", args: [investor.wallet_address] })
    .catch(() => null);
  if (holding === null) return { error: "chain" };
  const problem = checkOrder({ tokens: input.tokens, holding, supply: live.supply, cap: live.cap, paused: live.paused });
  if (problem) return { error: problem };

  const amount = quotePaisa(p, input.tokens);
  const pool = await db();
  const client = await pool.connect();
  let id: string;
  try {
    await client.query("BEGIN");
    const bankRef = `RAAST-DEMO-${randomBytes(6).toString("hex").toUpperCase()}`;
    const newSubId = randomUUID();
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO webdemo.subscriptions (id, request_id, investor_id, symbol, tokens, amount_paisa, bank_ref, ref_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'paid')
       ON CONFLICT (request_id) DO NOTHING RETURNING id`,
      [newSubId, input.requestId, investor.id, p.symbol, input.tokens.toString(), amount.toString(), bankRef, refIdFor(newSubId)],
    );
    const newId = inserted.rows[0]?.id;
    if (!newId) {
      // Same request submitted twice (double click, refresh): return the first one, never charge again.
      await client.query("ROLLBACK");
      const { rows } = await pool.query<{ id: string }>(
        "SELECT id FROM webdemo.subscriptions WHERE request_id = $1 AND investor_id = $2",
        [input.requestId, investor.id],
      );
      const existing = rows[0]?.id;
      return existing ? { subscriptionId: existing } : { error: "generic" };
    }
    id = newId;

    await openAccount(client, BANK, "asset", "PKR");
    await openAccount(client, investorAccount(investor.id), "liability", "PKR");
    await openAccount(client, capitalAccount(p.symbol), "equity", "PKR");
    await postJournal(client, {
      idempotencyKey: `web:sub:${id}:paid`,
      kind: "subscription_paid",
      memo: `Raast payment (demo) for ${input.tokens.toString()} ${p.symbol}`,
      externalRef: bankRef,
      createdBy: BY,
      postings: [
        { account: BANK, amount },
        { account: investorAccount(investor.id), amount: -amount },
      ],
    });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }

  await mint(id, investor.wallet_address);
  return { subscriptionId: id };
}

/** Claims a paid subscription and mints its tokens; exactly one caller can claim it. */
export async function mint(id: string, to: Address): Promise<void> {
  const pool = await db();
  const claimed = await pool.query<SubscriptionRow>(
    "UPDATE webdemo.subscriptions SET status = 'minting', updated_at = now() WHERE id = $1 AND status = 'paid' RETURNING *",
    [id],
  );
  const sub = claimed.rows[0];
  if (!sub) return;
  const issuance = latestDeployment()?.get("issuance");
  if (!issuance) {
    await refund(sub, "no deployment on the local chain; nothing was sent");
    return;
  }

  let hash: Hex;
  try {
    hash = await send(platformAccount("ISSUANCE_SAFE"), {
      address: issuance,
      abi: issuanceGuardAbi,
      functionName: "mint",
      args: [to, BigInt(sub.tokens), sub.ref_id],
    });
  } catch (e) {
    if (e instanceof NotSentError) await refund(sub, "refused by on-chain checks before sending");
    else await markReview(sub.id, "mint broadcast failed; outcome unknown");
    return;
  }
  try {
    await waitSuccess(hash);
  } catch (e) {
    if (e instanceof RevertedError) await refund(sub, `mint reverted (${hash})`);
    else await markReview(sub.id, `mint ${hash} not confirmed in time`);
    return;
  }
  await settle(sub, hash);
}

async function settle(sub: SubscriptionRow, hash: Hex): Promise<void> {
  const pool = await db();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Status first: only the caller that moves the row may post the journal.
    const moved = await client.query(
      "UPDATE webdemo.subscriptions SET status = 'done', mint_tx = $2, note = NULL, updated_at = now() WHERE id = $1 AND status IN ('minting', 'review')",
      [sub.id, hash],
    );
    if (moved.rowCount !== 1) {
      await client.query("ROLLBACK");
      return;
    }
    const amount = BigInt(sub.amount_paisa);
    await postJournal(client, {
      idempotencyKey: `web:sub:${sub.id}:settled`,
      kind: "subscription_settled",
      memo: `${sub.tokens} ${sub.symbol} minted`,
      externalRef: hash,
      createdBy: BY,
      postings: [
        { account: investorAccount(sub.investor_id), amount },
        { account: capitalAccount(sub.symbol), amount: -amount },
      ],
    });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

async function refund(sub: SubscriptionRow, reason: string): Promise<void> {
  const pool = await db();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const moved = await client.query(
      "UPDATE webdemo.subscriptions SET status = 'refunded', note = $2, updated_at = now() WHERE id = $1 AND status = 'minting'",
      [sub.id, reason.slice(0, 300)],
    );
    if (moved.rowCount !== 1) {
      await client.query("ROLLBACK");
      return;
    }
    const amount = BigInt(sub.amount_paisa);
    await postJournal(client, {
      idempotencyKey: `web:sub:${sub.id}:refunded`,
      kind: "subscription_refunded",
      memo: `Refund: ${reason}`.slice(0, 500),
      externalRef: sub.bank_ref,
      createdBy: BY,
      postings: [
        { account: investorAccount(sub.investor_id), amount },
        { account: BANK, amount: -amount },
      ],
    });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

async function markReview(id: string, reason: string, from: SubscriptionStatus[] = ["minting"]): Promise<void> {
  await (await db()).query(
    "UPDATE webdemo.subscriptions SET status = 'review', note = $2, updated_at = now() WHERE id = $1 AND status = ANY($3)",
    [id, reason.slice(0, 300), from],
  );
}

/**
 * Reconciles an investor's unfinished subscriptions with the chain. Only ever moves forward to
 * "done" when the chain shows the refId as used; refunds for unknown outcomes stay a manual
 * operations decision. A "minting" row older than two minutes (crashed request) goes to review;
 * a "paid" row that was never claimed is minted now.
 */
export async function reconcile(investor: InvestorRow): Promise<void> {
  const pool = await db();
  const { rows } = await pool.query<SubscriptionRow>(
    `SELECT * FROM webdemo.subscriptions WHERE investor_id = $1
       AND (status = 'review' OR (status IN ('paid', 'minting') AND updated_at < now() - interval '2 minutes'))`,
    [investor.id],
  );
  const issuance = latestDeployment()?.get("issuance");
  if (!issuance || rows.length === 0) return;
  for (const sub of rows) {
    if (sub.status === "paid") {
      // Never claimed, so nothing was broadcast: finish the order (the chain re-checks every rule).
      await mint(sub.id, investor.wallet_address);
      continue;
    }
    const used = await publicClient
      .readContract({ address: issuance, abi: issuanceGuardAbi, functionName: "refUsed", args: [sub.ref_id] })
      .catch(() => null);
    if (used === true) {
      // The refId alone is not enough: the mint must be to this investor, for exactly this amount.
      const logs = await publicClient
        .getContractEvents({ address: issuance, abi: issuanceGuardAbi, eventName: "Minted", args: { refId: sub.ref_id }, fromBlock: 0n })
        .catch(() => null);
      const match = logs?.find(
        (l) => l.args.to?.toLowerCase() === investor.wallet_address.toLowerCase() && l.args.amount === BigInt(sub.tokens),
      );
      if (match) await settle(sub, match.transactionHash);
      else if (logs !== null) await markReview(sub.id, "on-chain use of this reference does not match the subscription", ["minting", "review"]);
    } else if (sub.status === "minting") {
      await markReview(sub.id, "request interrupted; waiting for reconciliation");
    }
  }
}

export async function subscriptionsOf(investorId: string): Promise<SubscriptionRow[]> {
  const { rows } = await (await db()).query<SubscriptionRow>(
    "SELECT * FROM webdemo.subscriptions WHERE investor_id = $1 ORDER BY created_at DESC LIMIT 50",
    [investorId],
  );
  return rows;
}

export async function subscriptionById(investorId: string, id: string): Promise<SubscriptionRow | null> {
  const { rows } = await (await db()).query<SubscriptionRow>(
    "SELECT * FROM webdemo.subscriptions WHERE id = $1 AND investor_id = $2",
    [id, investorId],
  );
  return rows[0] ?? null;
}

/** Whether IssuanceGuard has consumed this refId: the chain's view of the subscription. */
export async function refUsedOnChain(refId: Hex): Promise<boolean | null> {
  const issuance = latestDeployment()?.get("issuance");
  if (!issuance) return null;
  return publicClient
    .readContract({ address: issuance, abi: issuanceGuardAbi, functionName: "refUsed", args: [refId] })
    .catch(() => null);
}

export { BANK, capitalAccount, investorAccount };
