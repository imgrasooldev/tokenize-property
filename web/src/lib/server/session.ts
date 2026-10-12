import { cookies } from "next/headers";
import { hmac, safeEqual } from "./secrets";

const COOKIE = "pt_session";
const TTL_SECONDS = 8 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Signed, HttpOnly, SameSite=Strict session cookie: "<investorId>.<expiry>.<hmac>". */
export async function startSession(investorId: string): Promise<void> {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const payload = `${investorId}.${exp}`;
  (await cookies()).set(COOKIE, `${payload}.${hmac("session", payload)}`, {
    httpOnly: true,
    sameSite: "strict",
    // WEB_PLAIN_HTTP=1 only for the private IP demo server, which has no TLS yet (owner decision).
    secure: process.env.NODE_ENV === "production" && process.env.WEB_PLAIN_HTTP !== "1",
    path: "/",
    maxAge: TTL_SECONDS,
  });
}

export async function endSession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

/** The signed-in investor id, or null if the cookie is missing, tampered with or expired. */
export async function currentInvestorId(): Promise<string | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;
  const [id, exp, sig] = raw.split(".");
  if (!id || !exp || !sig || !UUID.test(id) || !/^\d+$/.test(exp)) return null;
  if (!safeEqual(sig, hmac("session", `${id}.${exp}`))) return null;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return null;
  return id;
}
