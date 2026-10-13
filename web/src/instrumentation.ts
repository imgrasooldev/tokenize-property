/**
 * Runs once when the server process starts (Next.js instrumentation). Starts the settlement
 * follower (ADR 0010 §2) in the Node.js runtime only, so subscriptions, trades and sign-ups move
 * forward even when nobody has a page open.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startFollower } = await import("./lib/server/follower");
  startFollower();
}
