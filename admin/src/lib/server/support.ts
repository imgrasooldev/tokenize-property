import { db } from "./db";

/**
 * Investor support (T-049, migration 0031): one call of admin.support_lookup, which checks the
 * session and support.read itself and audits every lookup. Support-safe shape only: no name, CNIC
 * beyond the masked last four, compliance hold, case or decision reason ("refer_compliance").
 */
export interface SupportInvestor {
  ref: string;
  cnic: string;
  status: "verified" | "expired" | "pending" | "refer_compliance";
  since: string;
  wallet: string | null;
  notices: { kind: string; category: string; status: string; at: string }[];
}

export type SupportLookup =
  | { ok: false; error: string }
  | { ok: true; found: false; ambiguous?: boolean }
  | { ok: true; found: true; investor: SupportInvestor };

export async function supportLookup(sessionHash: Buffer, ref: string): Promise<SupportLookup> {
  const { rows } = await db().query<{ v: SupportLookup }>("SELECT admin.support_lookup($1, $2) AS v", [sessionHash, ref]);
  return rows[0]?.v ?? { ok: false, error: "no answer" };
}

export const STATUS_LABELS: Readonly<Record<SupportInvestor["status"], string>> = {
  verified: "Verified",
  expired: "Verification expired: the investor repeats the checks on the website",
  pending: "Verification in progress",
  refer_compliance: "Refer to compliance (do not discuss the reason with the investor)",
};
