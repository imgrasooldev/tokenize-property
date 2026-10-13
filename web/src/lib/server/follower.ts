import type pg from "pg";
import { db, runInBackgroundPool } from "./db";
import { settleSubscriptions } from "./invest";
import { logError } from "./log";
import { settleTrades } from "./market";
import { advanceOnboarding } from "./onboarding";

/**
 * Settlement follower (ADR 0010 §2): moves subscriptions, trades and sign-ups forward from the
 * outbox's final states, the read model and fresh chain proofs. Woken by the indexer's
 * `chain_events` notification (a batch with events was applied) and every 2 seconds. One pass at a
 * time across all processes (advisory lock); every step is idempotent and gated by a status change,
 * so a second runner would change nothing anyway.
 */
const LOCK = 586_586_032;
const POLL_MS = 2_000;

let running: Promise<void> | null = null;
let again = false;

/** One pass now (or right after the one in progress). Safe to call from anywhere. */
export function nudgeFollower(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = runInBackgroundPool(followOnce)
    .catch((e: unknown) => {
      logError("follower", e);
    })
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        void nudgeFollower();
      }
    });
  return running;
}

/** One full pass, holding the cross-process lock; returns at once if another process holds it. */
export async function followOnce(): Promise<void> {
  const client = await (await db()).connect();
  try {
    const { rows } = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [LOCK]);
    if (!rows[0]?.ok) return;
    try {
      await settleSubscriptions();
      await settleTrades();
      await advanceOnboarding();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK]);
    }
  } finally {
    client.release();
  }
}

const g = globalThis as unknown as { __ptFollower?: { timer: ReturnType<typeof setInterval>; listener: pg.PoolClient | null } };

/** Starts the background loop once per process (instrumentation.ts, tools). */
export function startFollower(): void {
  if (g.__ptFollower) return;
  const state: { timer: ReturnType<typeof setInterval>; listener: pg.PoolClient | null } = {
    timer: setInterval(() => void nudgeFollower(), POLL_MS),
    listener: null,
  };
  state.timer.unref();
  g.__ptFollower = state;
  process.stdout.write(`settlement follower started (every ${String(POLL_MS)} ms and on chain_events)\n`);
  void (async () => {
    try {
      const listener = await runInBackgroundPool(async () => (await db()).connect());
      listener.on("notification", () => void nudgeFollower());
      listener.on("error", () => {
        state.listener = null; // the 2-second timer keeps working
      });
      await listener.query("LISTEN chain_events");
      state.listener = listener;
    } catch (e) {
      logError("follower listen", e);
    }
  })();
}

/** Stops the loop (tests and tools). */
export async function stopFollower(): Promise<void> {
  const s = g.__ptFollower;
  if (!s) return;
  clearInterval(s.timer);
  if (s.listener) {
    await s.listener.query("UNLISTEN chain_events").catch(() => undefined);
    s.listener.release();
  }
  g.__ptFollower = undefined;
  await running;
}
