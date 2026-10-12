import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inspect, promisify } from "node:util";
import type { Hex, TransactionSerializableLegacy } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { z } from "zod";

/**
 * Key custody behind one interface (S-1). Callers can ask for an address and a signature, never for
 * key material. Local development uses encrypted key files; production plugs an HSM or MPC
 * provider into the same interface (FIPS 140-3 Level 3, keys generated inside the device).
 */
export interface KeyProvider {
  refs(): string[];
  address(ref: string): Hex;
  signTransaction(ref: string, tx: TransactionSerializableLegacy): Promise<Hex>;
}

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const KDF = { N: 2 ** 15, r: 8, p: 1 } as const;
const REF = /^[a-z][a-z0-9_]{2,40}$/;
const HEX = (n: number) => z.string().regex(new RegExp(`^[0-9a-f]{${String(n)}}$`)); // eslint-disable-line security/detect-non-literal-regexp -- fixed lengths

const fileSchema = z.object({
  version: z.literal(1),
  ref: z.string().regex(REF),
  address: z.string().regex(/^0x[0-9a-f]{40}$/),
  kdf: z.object({ name: z.literal("scrypt"), N: z.number().int(), r: z.number().int(), p: z.number().int(), salt: HEX(32) }),
  cipher: z.object({ name: z.literal("aes-256-gcm"), iv: HEX(24), tag: HEX(32), data: HEX(64) }),
});

async function deriveKey(passphrase: string, salt: Buffer, kdf: { N: number; r: number; p: number }): Promise<Buffer> {
  if (passphrase.length < 32) throw new Error("keystore passphrase must be at least 32 characters");
  return scrypt(passphrase, salt, 32, { ...kdf, maxmem: 128 * kdf.N * kdf.r * 2 });
}

/** Encrypts a private key into a keystore file (development setup; production keys never leave the HSM). */
export async function writeKeyFile(dir: string, ref: string, privateKey: Hex, passphrase: string): Promise<Hex> {
  if (!REF.test(ref)) throw new Error("invalid key ref");
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("invalid private key");
  const address = privateKeyToAccount(privateKey).address.toLowerCase() as Hex;
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt, KDF);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${ref}|${address}`));
  const data = Buffer.concat([cipher.update(Buffer.from(privateKey.slice(2), "hex")), cipher.final()]);
  const file = {
    version: 1,
    ref,
    address,
    kdf: { name: "scrypt", ...KDF, salt: salt.toString("hex") },
    cipher: { name: "aes-256-gcm", iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), data: data.toString("hex") },
  };
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- ref is validated above
  await writeFile(join(dir, `${ref}.json`), JSON.stringify(file, null, 2), { mode: 0o600, flag: "wx" });
  return address;
}

/** Keys decrypted into memory at startup. The class never exposes key material, even to logging. */
export class FileKeystore implements KeyProvider {
  readonly #accounts = new Map<string, PrivateKeyAccount>();

  private constructor() {}

  static async open(dir: string, passphrase: string): Promise<FileKeystore> {
    const ks = new FileKeystore();
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- configured directory
    for (const name of await readdir(dir)) {
      if (!/^[a-z][a-z0-9_]{2,40}\.json$/.test(name)) continue;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- name matched above
      const parsed = fileSchema.parse(JSON.parse(await readFile(join(dir, name), "utf8")));
      if (`${parsed.ref}.json` !== name) throw new Error(`key file ${name} does not match its ref`);
      const key = await deriveKey(passphrase, Buffer.from(parsed.kdf.salt, "hex"), parsed.kdf);
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.cipher.iv, "hex"));
      decipher.setAAD(Buffer.from(`${parsed.ref}|${parsed.address}`));
      decipher.setAuthTag(Buffer.from(parsed.cipher.tag, "hex"));
      let raw: Buffer;
      try {
        raw = Buffer.concat([decipher.update(Buffer.from(parsed.cipher.data, "hex")), decipher.final()]);
      } catch {
        throw new Error(`cannot decrypt key ${parsed.ref}: wrong passphrase or tampered file`);
      }
      const account = privateKeyToAccount(`0x${raw.toString("hex")}`);
      raw.fill(0);
      const expected = Buffer.from(parsed.address.slice(2), "hex");
      const actual = Buffer.from(account.address.slice(2).toLowerCase(), "hex");
      if (!timingSafeEqual(expected, actual)) throw new Error(`key ${parsed.ref} does not match its address`);
      ks.#accounts.set(parsed.ref, account);
    }
    return ks;
  }

  refs(): string[] {
    return [...this.#accounts.keys()];
  }

  address(ref: string): Hex {
    const a = this.#accounts.get(ref);
    if (!a) throw new Error(`unknown key ${ref}`);
    return a.address.toLowerCase() as Hex;
  }

  async signTransaction(ref: string, tx: TransactionSerializableLegacy): Promise<Hex> {
    const a = this.#accounts.get(ref);
    if (!a) throw new Error(`unknown key ${ref}`);
    return a.signTransaction(tx);
  }

  toJSON(): object {
    return { keys: this.refs().map((r) => ({ ref: r, address: this.address(r) })) };
  }

  [inspect.custom](): string {
    return `FileKeystore(${this.refs().join(", ")})`;
  }
}
