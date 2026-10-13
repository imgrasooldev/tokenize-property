import { NextResponse } from "next/server";

/** Liveness for systemd and tests: no data, no database call. */
export function GET() {
  return new NextResponse("ok\n", { status: 200, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
}
