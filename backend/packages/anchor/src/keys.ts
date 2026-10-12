import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { FileKeystore, writeKeyFile, type KeyProvider } from "@pt/signer";
import type { Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";

/** Key reference of the anchor key in its keystore. */
export const ANCHOR_KEY_REF = "anchor";

/**
 * LOCAL DEVELOPMENT ONLY: creates a fresh random anchor key in its own encrypted keystore directory
 * (separate from the signing service's, so the anchoring process never decrypts any other key).
 * Returns the address; the key itself is never returned or printed. Production keys are generated
 * inside the HSM/MPC provider and never exist in a file.
 */
export async function createDevAnchorKey(dir: string, passphrase: string): Promise<Hex> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- configured directory
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed file name in the configured directory
  if (existsSync(join(dir, `${ANCHOR_KEY_REF}.json`))) throw new Error("an anchor key already exists in this keystore");
  return writeKeyFile(dir, ANCHOR_KEY_REF, generatePrivateKey(), passphrase);
}

/** Opens the local anchor keystore; it must hold exactly the anchor key. */
export async function openDevAnchorKeys(dir: string, passphrase: string): Promise<KeyProvider> {
  const ks = await FileKeystore.open(dir, passphrase);
  const refs = ks.refs();
  if (refs.length !== 1 || refs[0] !== ANCHOR_KEY_REF) throw new Error(`the anchor keystore must hold only the "${ANCHOR_KEY_REF}" key`);
  return ks;
}
