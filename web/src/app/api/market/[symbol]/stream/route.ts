import { findProperty } from "@/lib/properties";
import { marketSnapshot, toView } from "@/lib/server/market";
import { keyFromForwarded, openStream } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";

const POLL_MS = 1_000;
const HEARTBEAT_MS = 15_000;
/** Connections are closed after five minutes; EventSource reconnects on its own. */
const MAX_MS = 5 * 60_000;

/**
 * Server-Sent Events: pushes the public market view (order book, trades, candles) whenever it
 * changes. Same-origin only (CSP connect-src 'self'); carries no investor identities.
 */
export async function GET(request: Request, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const p = findProperty(symbol);
  if (p?.status !== "live") return new Response("Not found", { status: 404 });
  const client = keyFromForwarded(request.headers.get("x-forwarded-for"));
  const release = openStream(client);
  if (!release) return new Response("Too many live connections", { status: 429, headers: { "Retry-After": "30" } });

  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const started = Date.now();
      let lastVersion = "";
      let lastBeat = Date.now();
      let busy = false;
      const close = () => {
        if (timer) clearInterval(timer);
        release();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      request.signal.addEventListener("abort", close);
      const tick = async () => {
        if (busy) return;
        busy = true;
        try {
          if (Date.now() - started > MAX_MS) {
            close();
            return;
          }
          const snap = await marketSnapshot(p.symbol);
          if (snap.version !== lastVersion) {
            lastVersion = snap.version;
            lastBeat = Date.now();
            controller.enqueue(encoder.encode(`event: market\ndata: ${JSON.stringify(toView(snap))}\n\n`));
          } else if (Date.now() - lastBeat > HEARTBEAT_MS) {
            lastBeat = Date.now();
            controller.enqueue(encoder.encode(": keep-alive\n\n"));
          }
        } catch {
          close();
        } finally {
          busy = false;
        }
      };
      void tick();
      timer = setInterval(() => void tick(), POLL_MS);
    },
    cancel() {
      if (timer) clearInterval(timer);
      release();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
