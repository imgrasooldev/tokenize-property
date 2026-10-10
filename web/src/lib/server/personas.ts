import { idFactoryAbi } from "../abis";
import { latestDeployment } from "./chain";
import { db } from "./db";
import { personaAccount, publicClient, type Persona } from "./demo-signer";
import { isVerifiedOnChain } from "./onboarding";

const NAMES: Record<Persona, string> = { ALICE: "Alice (demo)", BOB: "Bob (demo)" };

/** Creates or refreshes a demo persona's investor row from the chain; returns its id. */
export async function upsertPersona(persona: Persona): Promise<string> {
  const account = personaAccount(persona);
  const idFactory = latestDeployment()?.get("idFactory");
  const identity = idFactory
    ? await publicClient
        .readContract({ address: idFactory, abi: idFactoryAbi, functionName: "getIdentity", args: [account.address] })
        .catch(() => null)
    : null;
  const verified = (await isVerifiedOnChain(account.address)) === true;
  const { rows } = await (await db()).query<{ id: string }>(
    `INSERT INTO webdemo.investors (persona, display_name, wallet_address, identity_address, kyc_status)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (persona) DO UPDATE SET wallet_address = EXCLUDED.wallet_address,
       identity_address = EXCLUDED.identity_address, kyc_status = EXCLUDED.kyc_status
     RETURNING id`,
    [
      persona,
      persona === "ALICE" ? NAMES.ALICE : NAMES.BOB,
      account.address,
      identity && !/^0x0+$/.test(identity) ? identity : null,
      verified ? "verified" : "pending",
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("Could not create the persona");
  return id;
}
