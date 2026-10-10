import type { Account } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { InvestorRow } from "./db";
import { personaAccount } from "./demo-signer";
import { decrypt } from "./secrets";

/**
 * The custodial signing account of an investor (demo only: production keys live in an HSM/MPC
 * signing service, Step 5d). Refuses if the key does not belong to the wallet on record.
 */
export function signerFor(investor: InvestorRow): Account {
  let account: Account;
  if (investor.persona === "ALICE" || investor.persona === "BOB") {
    account = personaAccount(investor.persona);
  } else if (investor.wallet_key_enc) {
    account = privateKeyToAccount(decrypt(investor.wallet_key_enc) as `0x${string}`);
  } else {
    throw new Error("No custodial key for this investor");
  }
  if (account.address.toLowerCase() !== investor.wallet_address.toLowerCase()) {
    throw new Error("Custodial key does not match the wallet on record");
  }
  return account;
}
