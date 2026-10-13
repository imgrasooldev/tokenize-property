import type pg from "pg";
import type { Address, Hex } from "viem";

/**
 * The website's side of the outbox (ADR 0004, ADR 0010): commands are enqueued with
 * outbox.enqueue INSIDE the same transaction as the business change (O-1), and the website only
 * reads their state afterwards. Execution (signing service, record before broadcast) is the
 * outbox worker's job; the website never signs or broadcasts.
 */
type Db = pg.ClientBase | pg.Pool;

export type CommandKind = "issuance.mint" | "token.transfer" | "identity.create" | "identity.add_claim" | "identity.register";

export async function enqueue(c: Db, key: string, kind: CommandKind, payload: Record<string, unknown>, ref: string): Promise<bigint> {
  const { rows } = await c.query<{ id: string }>("SELECT outbox.enqueue($1, $2, $3::jsonb, $4, 'web', 5) AS id", [key, kind, JSON.stringify(payload), ref]);
  const id = rows[0]?.id;
  if (!id) throw new Error("outbox.enqueue returned nothing");
  return BigInt(id);
}

export type CommandStatus = "pending" | "claimed" | "submitted" | "confirmed" | "failed" | "review";

export interface CommandState {
  id: string;
  status: CommandStatus;
  txHash: Hex | null;
  txNonce: bigint | null;
  txFrom: Address | null;
  lastError: string | null;
}

/** States of the given commands by id. */
export async function commandStates(c: Db, ids: (string | null)[]): Promise<Map<string, CommandState>> {
  const wanted = ids.filter((x): x is string => x !== null);
  if (wanted.length === 0) return new Map();
  const { rows } = await c.query<{ id: string; status: CommandStatus; tx_hash: Hex | null; tx_nonce: string | null; tx_from: Address | null; last_error: string | null }>(
    "SELECT id, status, tx_hash, tx_nonce, tx_from, last_error FROM outbox.commands WHERE id = ANY($1::bigint[])",
    [wanted],
  );
  return new Map(
    rows.map((r) => [
      r.id,
      { id: r.id, status: r.status, txHash: r.tx_hash, txNonce: r.tx_nonce === null ? null : BigInt(r.tx_nonce), txFrom: r.tx_from, lastError: r.last_error },
    ]),
  );
}

/** What an investor sees for an unfinished command. */
export type Phase = "queued" | "approval" | "confirming";

export function phaseOf(s: CommandState | undefined): Phase {
  if (!s) return "queued";
  if (s.status === "submitted" || s.status === "confirmed") return "confirming";
  if (s.status === "pending" && /awaiting \d+ approvals/.test(s.lastError ?? "")) return "approval";
  return "queued";
}
