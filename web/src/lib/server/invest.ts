import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import type { Address, Hex } from "viem";
import { checkOrder, quotePaisa, refIdFor, type OrderProblem } from "../invest-rules";
import { findProperty } from "../properties";
import { latestDeployment, refUsedOnChain, txOutcome } from "./chain";
import { db, tx, type InvestorRow } from "./db";
import { openAccount, postJournal } from "./ledger";
import { commandStates, enqueue, phaseOf, type CommandState, type Phase } from "./outbox";
import { holdingOf, issuanceOf, liveToken, registeredOnChain } from "./readmodel";

/**
 * W3 invest flow on the outbox and the signing service (Step 5h, ADR 0010):
 *   mock Raast payment -> ONE transaction: subscription + `subscription_paid` journal + outbox
 *   `issuance.mint` command -> outbox worker -> signing service (policy, maker-checker above the
 *   threshold, nonce, audit; record before broadcast) -> chain -> indexer -> settlement.
 *
 * Safety rules (unchanged since W3, now enforced by the outbox for sending and by the settlement
 * follower for settling):
 * - Money is recorded in the ledger in the same transaction as the mint command; every journal
 *   has an idempotency key, so nothing is charged or settled twice.
 * - Each subscription has a single-use IssuanceGuard refId, so it can never mint twice (I-11).
 * - Settled only when the read model shows the Minted event for this refId TO THIS WALLET FOR
 *   EXACTLY THIS AMOUNT. Refunded only when the mint provably never happened: the command FAILED
 *   (final), the refId is unused on chain, and no transaction was recorded or the chain proves the
 *   recorded one reverted or was dropped. Anything else goes to review; nothing is refunded while
 *   a command is in the outbox's review (an operator retry would revive it).
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
  mint_nonce: number | null;
  mint_from: Address | null;
  command_id: string | null;
  note: string | null;
  created_at: Date;
  updated_at: Date;
}

const BANK = "web:bank:subscriptions";
const investorAccount = (investorId: string) => `web:investor:${investorId}:subscription`;
const capitalAccount = (symbol: string) => `web:property:${symbol.toLowerCase()}:capital`;
const BY = "web-prototype";

/** Tokens this investor has asked for or bought that the read model does not show yet. */
async function inFlightTokens(c: pg.ClientBase | pg.Pool, investorId: string): Promise<bigint> {
  const { rows } = await c.query<{ n: string }>(
    `SELECT coalesce((SELECT sum(tokens) FROM webdemo.subscriptions WHERE investor_id = $1 AND status IN ('paid', 'minting', 'review')), 0)
          + coalesce((SELECT sum(tokens) FROM webdemo.trades WHERE buyer_id = $1 AND status IN ('settling', 'review')), 0) AS n`,
    [investorId],
  );
  return BigInt(rows[0]?.n ?? "0");
}

/** Tokens being minted for anyone: they count against the trustee cap before the read model shows them. */
async function mintsInFlight(c: pg.ClientBase | pg.Pool): Promise<bigint> {
  const { rows } = await c.query<{ n: string }>("SELECT coalesce(sum(tokens), 0) AS n FROM webdemo.subscriptions WHERE status IN ('paid', 'minting', 'review')");
  return BigInt(rows[0]?.n ?? "0");
}

/** The outbox payload of a subscription's mint: what the signing service checks and signs. */
function mintPayload(sub: Pick<SubscriptionRow, "tokens" | "ref_id">, wallet: Address): Record<string, unknown> | null {
  const issuance = latestDeployment()?.get("issuance");
  if (!issuance) return null;
  return { issuance, to: wallet.toLowerCase(), amount: sub.tokens, refId: sub.ref_id };
}

export async function placeOrder(
  investor: InvestorRow,
  input: { symbol: string; tokens: bigint; requestId: string },
): Promise<{ subscriptionId: string } | { error: InvestError }> {
  const p = findProperty(input.symbol);
  if (p?.status !== "live") return { error: "notLive" };
  if (investor.kyc_status !== "verified" || (await registeredOnChain(investor.wallet_address)) !== true) {
    return { error: "unverified" };
  }
  const live = await liveToken(p.symbol, true);
  const held = await holdingOf(investor.wallet_address);
  if (!live || held === null || !latestDeployment()?.get("issuance")) return { error: "chain" };

  const amount = quotePaisa(p, input.tokens);
  return tx(async (c): Promise<{ subscriptionId: string } | { error: InvestError }> => {
    // One placement at a time per investor, so in-flight amounts cannot race each other.
    await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [586_586_021, investor.id]);
    const again = await c.query<{ id: string }>("SELECT id FROM webdemo.subscriptions WHERE request_id = $1 AND investor_id = $2", [input.requestId, investor.id]);
    // Same request submitted twice (double click, refresh): return the first one, never charge again.
    const existing = again.rows[0]?.id;
    if (existing) return { subscriptionId: existing };

    // Read model + everything in flight: never under-counts (ADR 0010 §1).
    const problem = checkOrder({
      tokens: input.tokens,
      holding: held + (await inFlightTokens(c, investor.id)),
      supply: live.supply + (await mintsInFlight(c)),
      cap: live.cap,
      paused: live.paused,
    });
    if (problem) return { error: problem };

    const id = randomUUID();
    const sub = { tokens: input.tokens.toString(), ref_id: refIdFor(id) };
    const payload = mintPayload(sub, investor.wallet_address);
    if (!payload) return { error: "chain" };
    const bankRef = `RAAST-DEMO-${randomBytes(6).toString("hex").toUpperCase()}`;
    const inserted = await c.query(
      `INSERT INTO webdemo.subscriptions (id, request_id, investor_id, symbol, tokens, amount_paisa, bank_ref, ref_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'minting') ON CONFLICT (request_id) DO NOTHING`,
      [id, input.requestId, investor.id, p.symbol, sub.tokens, amount.toString(), bankRef, sub.ref_id],
    );
    if (inserted.rowCount !== 1) throw new Error("request id used by another investor");
    await openAccount(c, BANK, "asset", "PKR");
    await openAccount(c, investorAccount(investor.id), "liability", "PKR");
    await openAccount(c, capitalAccount(p.symbol), "equity", "PKR");
    await postJournal(c, {
      idempotencyKey: `web:sub:${id}:paid`,
      kind: "subscription_paid",
      memo: `Raast payment (demo) for ${sub.tokens} ${p.symbol}`,
      externalRef: bankRef,
      createdBy: BY,
      postings: [
        { account: BANK, amount },
        { account: investorAccount(investor.id), amount: -amount },
      ],
    });
    const command = await enqueue(c, `web:sub:${id}:mint`, "issuance.mint", payload, `web:sub:${id}`);
    await c.query("UPDATE webdemo.subscriptions SET command_id = $2 WHERE id = $1", [id, command.toString()]);
    return { subscriptionId: id };
  });
}

// ------------------------------------------------------------------ settlement (follower)

async function settle(sub: SubscriptionRow, hash: Hex): Promise<void> {
  await tx(async (c) => {
    // Status first: only the caller that moves the row may post the journal.
    const moved = await c.query(
      "UPDATE webdemo.subscriptions SET status = 'done', mint_tx = $2, note = NULL, updated_at = now() WHERE id = $1 AND status IN ('paid', 'minting', 'review')",
      [sub.id, hash],
    );
    if (moved.rowCount !== 1) return;
    const amount = BigInt(sub.amount_paisa);
    await postJournal(c, {
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
  });
}

async function refund(sub: SubscriptionRow, reason: string): Promise<void> {
  await tx(async (c) => {
    const moved = await c.query(
      "UPDATE webdemo.subscriptions SET status = 'refunded', note = $2, updated_at = now() WHERE id = $1 AND status IN ('paid', 'minting', 'review')",
      [sub.id, reason.slice(0, 300)],
    );
    if (moved.rowCount !== 1) return;
    const amount = BigInt(sub.amount_paisa);
    await postJournal(c, {
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
  });
}

async function setStatus(id: string, status: "minting" | "review", reason: string | null): Promise<void> {
  await (await db()).query(
    "UPDATE webdemo.subscriptions SET status = $2, note = $3, updated_at = now() WHERE id = $1 AND status IN ('paid', 'minting', 'review') AND (status <> $2 OR note IS DISTINCT FROM $3)",
    [id, status, reason?.slice(0, 300) ?? null],
  );
}

/**
 * The mint never happened and never can: the refId is unused on chain, and no transaction was
 * recorded or the recorded one reverted or was dropped. Anything else (chain unreachable, still
 * pending, mined) is not a proof.
 */
async function provablyNotMinted(refId: Hex, recorded: { hash: Hex; from: Address; nonce: bigint } | null): Promise<{ proven: boolean; detail: string }> {
  if ((await refUsedOnChain(refId)) !== false) return { proven: false, detail: "the chain shows the reference used, or cannot be read" };
  if (!recorded) return { proven: true, detail: "no transaction was ever sent" };
  const outcome = await txOutcome(recorded.hash, recorded.from, recorded.nonce);
  return outcome === "reverted" || outcome === "dropped"
    ? { proven: true, detail: `mint ${outcome} (${recorded.hash}); nothing was issued` }
    : { proven: false, detail: `mint ${recorded.hash} is ${outcome}` };
}

/** Settles against the read model when it shows a matching mint. */
async function settleFromReadModel(sub: SubscriptionRow, wallet: Address): Promise<"settled" | "mismatch" | "absent" | "unavailable"> {
  const minted = await issuanceOf(sub.ref_id);
  if (minted === undefined) return "unavailable";
  if (minted === null) return "absent";
  // The refId alone is not enough: the mint must be to this investor, for exactly this amount.
  if (minted.account.toLowerCase() !== wallet.toLowerCase() || minted.amount !== BigInt(sub.tokens)) return "mismatch";
  await settle(sub, minted.txHash);
  return "settled";
}

/**
 * One pass over every unfinished subscription (called by the follower). Decides only from the
 * final outbox state, the read model and, before a refund, a fresh chain proof (ADR 0010 §2).
 */
let lastSlowPass = 0;

export async function settleSubscriptions(): Promise<void> {
  const pool = await db();
  const { rows } = await pool.query<SubscriptionRow & { wallet: Address; stale: boolean }>(
    `SELECT s.*, i.wallet_address AS wallet, s.updated_at < now() - interval '2 minutes' AS stale
     FROM webdemo.subscriptions s JOIN webdemo.investors i ON i.id = s.investor_id
     WHERE s.status IN ('paid', 'minting', 'review') ORDER BY s.created_at LIMIT 200`,
  );
  if (rows.length === 0) return;
  // Rows in review and pre-5h rows need chain reads and rarely change: look at them every 30 s, not
  // on every 2-second pass.
  const slow = Date.now() - lastSlowPass >= 30_000;
  if (slow) lastSlowPass = Date.now();
  const commands = await commandStates(pool, rows.map((r) => r.command_id));
  for (const sub of rows) {
    const cmd = sub.command_id ? commands.get(sub.command_id) : undefined;
    if ((sub.status === "review" || !sub.command_id) && !slow && !(cmd && cmd.status !== "review" && cmd.status !== "failed")) continue;
    if (!sub.command_id) {
      await settleLegacy(sub, sub.wallet, sub.stale);
      continue;
    }
    if (!cmd) continue;
    switch (cmd.status) {
      case "confirmed": {
        const r = await settleFromReadModel(sub, sub.wallet);
        if (r === "mismatch") await setStatus(sub.id, "review", "on-chain use of this reference does not match the subscription");
        break; // absent: the indexer has not reached the block yet (pending)
      }
      case "failed": {
        // A matching mint settles even here (an operator may have failed a command whose transaction
        // was mined); a mismatch goes to operations; read model unavailable: decide nothing.
        const r = await settleFromReadModel(sub, sub.wallet);
        if (r === "settled" || r === "unavailable") break;
        if (r === "mismatch") {
          await setStatus(sub.id, "review", "on-chain use of this reference does not match the subscription");
          break;
        }
        const recorded = cmd.txHash && cmd.txFrom && cmd.txNonce !== null ? { hash: cmd.txHash, from: cmd.txFrom, nonce: cmd.txNonce } : null;
        const proof = await provablyNotMinted(sub.ref_id, recorded);
        if (proof.proven) await refund(sub, `${cmd.lastError ?? "refused"}; ${proof.detail}`);
        else await setStatus(sub.id, "review", `mint command failed; ${proof.detail}`);
        break;
      }
      case "review":
        await setStatus(sub.id, "review", `held for operations: ${cmd.lastError ?? "outcome unknown"}`);
        break;
      default:
        // pending / claimed / submitted: in progress (an operator retry also lands here).
        if (sub.status === "review") await setStatus(sub.id, "minting", null);
    }
  }
}

/**
 * Subscriptions from before Step 5h (no outbox command): never sent again by the website. A paid
 * row that was never claimed gets its mint command now; a row the old demo signer was minting is
 * resolved from the read model and the chain exactly as before.
 */
async function settleLegacy(sub: SubscriptionRow, wallet: Address, stale: boolean): Promise<void> {
  if (sub.status === "paid") {
    const payload = mintPayload(sub, wallet);
    if (!payload) return;
    await tx(async (c) => {
      const command = await enqueue(c, `web:sub:${sub.id}:mint`, "issuance.mint", payload, `web:sub:${sub.id}`);
      await c.query("UPDATE webdemo.subscriptions SET status = 'minting', command_id = $2, updated_at = now() WHERE id = $1 AND status = 'paid'", [sub.id, command.toString()]);
    });
    return;
  }
  if (sub.status === "minting" && !stale) return;
  const r = await settleFromReadModel(sub, wallet);
  if (r === "settled" || r === "unavailable") return;
  if (r === "mismatch") {
    await setStatus(sub.id, "review", "on-chain use of this reference does not match the subscription");
    return;
  }
  const recorded = sub.mint_tx && sub.mint_from && sub.mint_nonce !== null ? { hash: sub.mint_tx, from: sub.mint_from, nonce: BigInt(sub.mint_nonce) } : null;
  const proof = await provablyNotMinted(sub.ref_id, recorded);
  if (proof.proven) await refund(sub, proof.detail);
  else if (sub.status === "minting") await setStatus(sub.id, "review", "request interrupted; waiting for the chain");
}

// ------------------------------------------------------------------ reads

export async function subscriptionsOf(investorId: string): Promise<SubscriptionRow[]> {
  const { rows } = await (await db()).query<SubscriptionRow>(
    "SELECT * FROM webdemo.subscriptions WHERE investor_id = $1 ORDER BY created_at DESC LIMIT 50",
    [investorId],
  );
  return rows;
}

export async function subscriptionById(investorId: string, id: string): Promise<SubscriptionRow | null> {
  const { rows } = await (await db()).query<SubscriptionRow>("SELECT * FROM webdemo.subscriptions WHERE id = $1 AND investor_id = $2", [id, investorId]);
  return rows[0] ?? null;
}

/** For unfinished subscriptions: queued, awaiting approval, or confirming on chain. */
export async function phasesOf(subs: SubscriptionRow[]): Promise<Map<string, Phase>> {
  const open = subs.filter((s) => s.status === "minting" || s.status === "paid");
  const states: Map<string, CommandState> = await commandStates(await db(), open.map((s) => s.command_id));
  return new Map(open.map((s) => [s.id, phaseOf(s.command_id ? states.get(s.command_id) : undefined)]));
}

export { BANK, capitalAccount, investorAccount };
