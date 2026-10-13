import type { NextRequest } from "next/server";
import { db } from "@/lib/server/db";
import { json, readJson, withCeremony } from "@/lib/server/http";
import { clientKey, take } from "@/lib/server/rate-limit";
import { deny, hashToken, newToken, sameOrigin } from "@/lib/server/session";
import { newChallenge, recordFailure, registrationOptions, storeChallenge } from "@/lib/server/webauthn";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Starts an enrolment from a one-time link (the token travels in the URL fragment, never in logs). */
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return deny(403, "cross-origin request refused");
  if (!take("enrol", clientKey(request))) return deny(429, "too many attempts, wait a minute");
  const body = await readJson(request);
  const token = body?.token;
  if (typeof token !== "string" || !TOKEN.test(token)) return deny(400, "this enrolment link is not valid");
  const tokenHash = hashToken(token);
  const { rows } = await db().query<{ officer_id: string; handle: string; display_name: string }>(
    "SELECT * FROM admin.enrolment_officer($1)",
    [tokenHash],
  );
  const officer = rows[0];
  if (!officer) {
    await recordFailure("enrol", "link not valid, used or expired", null);
    return deny(400, "this enrolment link is not valid, already used or expired: ask for a new one");
  }
  const ceremony = newToken();
  const options = await registrationOptions({ id: officer.officer_id, handle: officer.handle, name: officer.display_name }, newChallenge());
  await storeChallenge(hashToken(ceremony), "enrol", options.challenge, { enrolToken: tokenHash });
  return withCeremony(json({ options, officer: { handle: officer.handle, name: officer.display_name } }), ceremony);
}
