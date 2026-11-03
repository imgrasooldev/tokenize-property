import type { TitleFetch } from "./service.ts";

/**
 * DEMO / LOCAL ONLY: a title inquiry that answers the title the investor typed, as if the bank's
 * record always matched what the customer says. It does NOT weaken the name check: the database
 * (bank.register_payee, B-4) still compares the keyed hash of that title with the KYC-verified
 * name, so a title that is not the investor's verified name is refused.
 *
 * Production plugs a real 1LINK / Raast account-title fetch into BankService instead, which ignores
 * the claimed title. This class refuses to be constructed when NODE_ENV is "production".
 */
export class DemoTitleFetch implements TitleFetch {
  constructor() {
    if (process.env.NODE_ENV === "production") throw new Error("DemoTitleFetch echoes the claimed title and must not run in production");
  }

  accountTitle(_iban: string, claimedTitle?: string): Promise<string | null> {
    const t = claimedTitle?.trim();
    return Promise.resolve(t ? t : null);
  }

  /** Spec S-08 RD-5 mock convention: a 16-digit account number starting with 9 is a Roshan Digital Account. */
  accountKind(iban: string): Promise<"domestic" | "rda"> {
    return Promise.resolve(iban.slice(-16).startsWith("9") ? "rda" : "domestic");
  }
}
