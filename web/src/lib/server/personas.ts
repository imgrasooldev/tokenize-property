import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";
import { db } from "./db";
import { registeredIdentity, registeredOnChain } from "./readmodel";

export type Persona = "ALICE" | "BOB";
const NAMES: Record<Persona, string> = { ALICE: "Alice (demo)", BOB: "Bob (demo)" };

/**
 * The demo personas' PUBLIC addresses from chain/network/dev-accounts.env (local dev chain only).
 * Their keys are custodial wallets of the signing service (`npm run signer:setup`); the website
 * reads only the address lines, never a key.
 */
function personaAddress(persona: Persona): Address {
  const file = join(process.cwd(), "..", "chain", "network", "dev-accounts.env");
  // Fixed path inside the repository.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (!existsSync(file)) throw new Error("Local dev accounts not found. Run `python chain/net.py setup`.");
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.startsWith(`${persona}=`)) {
      const a = line.slice(persona.length + 1).trim();
      if (/^0x[0-9a-fA-F]{40}$/.test(a)) return a.toLowerCase() as Address;
    }
  }
  throw new Error(`No local dev address for ${persona}`);
}

/** Creates or refreshes a demo persona's investor row from the read model; returns its id. */
export async function upsertPersona(persona: Persona): Promise<string> {
  const wallet = personaAddress(persona);
  const [verified, identity] = await Promise.all([registeredOnChain(wallet), registeredIdentity(wallet)]);
  const { rows } = await (await db()).query<{ id: string }>(
    `INSERT INTO webdemo.investors (persona, display_name, wallet_address, identity_address, kyc_status)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (persona) DO UPDATE SET wallet_address = EXCLUDED.wallet_address,
       identity_address = EXCLUDED.identity_address, kyc_status = EXCLUDED.kyc_status
     RETURNING id`,
    [persona, persona === "ALICE" ? NAMES.ALICE : NAMES.BOB, wallet, identity, verified === true ? "verified" : "pending"],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("Could not create the persona");
  return id;
}
