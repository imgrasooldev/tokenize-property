import type { NextRequest } from "next/server";
import { json, withCeremony } from "@/lib/server/http";
import { clientKey, take } from "@/lib/server/rate-limit";
import { deny, hashToken, newToken, sameOrigin } from "@/lib/server/session";
import { authenticationOptions, newChallenge, storeChallenge } from "@/lib/server/webauthn";

/** Starts a sign-in: a fresh challenge, stored hashed by ceremony id, bound to this browser by a cookie. */
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return deny(403, "cross-origin request refused");
  if (!take("login", clientKey(request))) return deny(429, "too many attempts, wait a minute");
  const ceremony = newToken();
  const options = await authenticationOptions(newChallenge());
  await storeChallenge(hashToken(ceremony), "login", options.challenge, {});
  return withCeremony(json({ options }), ceremony);
}
