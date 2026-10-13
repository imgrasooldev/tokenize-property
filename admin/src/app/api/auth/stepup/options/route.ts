import type { NextRequest } from "next/server";
import { db } from "@/lib/server/db";
import { json, withCeremony } from "@/lib/server/http";
import { clientKey, take } from "@/lib/server/rate-limit";
import { deny, hashToken, newToken, requireApi } from "@/lib/server/session";
import { authenticationOptions, newChallenge, storeChallenge } from "@/lib/server/webauthn";

/** Step-up: a new assertion from the signed-in officer's own key, bound to this session. */
export async function POST(request: NextRequest) {
  const officer = await requireApi(request, "officer");
  if (!("sessionHash" in officer)) return officer;
  if (!take("stepup", clientKey(request))) return deny(429, "too many attempts, wait a minute");
  const { rows } = await db().query<{ id: string; transports: string[] }>("SELECT * FROM admin.session_credentials($1)", [
    officer.sessionHash,
  ]);
  const ceremony = newToken();
  const options = await authenticationOptions(newChallenge(), rows);
  await storeChallenge(hashToken(ceremony), "step_up", options.challenge, { session: officer.sessionHash });
  return withCeremony(json({ options }), ceremony);
}
