import type { PasskeyRow } from "@/components/passkey/PasskeyPanel";
import type { Lang } from "../i18n";
import { db } from "./db";

/**
 * The signed-in investor's active passkeys for /account (webauth.web_passkeys, migration 0024):
 * label, synced or device-bound, added and last used. No credential ID, public key or counter ever
 * reaches the page; a passkey is referred to by its own random reference.
 */
export async function listPasskeys(session: Buffer, lang: Lang): Promise<PasskeyRow[]> {
  const { rows } = await (await db()).query<{ ref: string; name: string; synced: boolean; created_at: Date; last_used_at: Date | null; this_session: boolean }>(
    "SELECT * FROM webauth.web_passkeys($1)",
    [session],
  );
  const fmt = new Intl.DateTimeFormat(lang === "ur" ? "ur-PK" : "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Karachi" });
  return rows.map((r) => ({
    ref: r.ref,
    name: r.name,
    synced: r.synced,
    added: fmt.format(r.created_at),
    lastUsed: r.last_used_at ? fmt.format(r.last_used_at) : null,
    thisSession: r.this_session,
  }));
}
