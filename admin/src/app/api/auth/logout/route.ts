import type { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/server/config";
import { db } from "@/lib/server/db";
import { seeOther } from "@/lib/server/http";
import { COOKIE_OPTIONS, requireApi } from "@/lib/server/session";

/** Sign-out: a form POST with the CSRF token; the database ends the session and audits it. */
export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => undefined);
  const officer = await requireApi(request, "officer", form);
  if (!("sessionHash" in officer)) return officer;
  await db().query("SELECT admin.end_session($1, 'logout')", [officer.sessionHash]);
  const res = seeOther("/login?bye=1");
  res.cookies.set(SESSION_COOKIE, "", { ...COOKIE_OPTIONS, maxAge: 0 });
  return res;
}
