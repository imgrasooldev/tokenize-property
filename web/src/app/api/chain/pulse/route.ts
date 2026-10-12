import { chainPulse } from "@/lib/server/pulse";

export const dynamic = "force-dynamic";

/**
 * Public network pulse (latest blocks, validators, live token price and supply, ledger check) for
 * the status rail and the live block row. Read-only, same origin, no personal data; one shared
 * value per second for every caller (see chainPulse).
 */
export async function GET() {
  const pulse = await chainPulse();
  return Response.json(pulse, { headers: { "Cache-Control": "no-store" } });
}
