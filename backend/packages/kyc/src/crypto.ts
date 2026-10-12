import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/**
 * Keyed hashing and sealing of personal data (ADR 0009, Y-1).
 *
 * - A pepper is a 32-byte secret held by the service (KMS/HSM in production), never by the
 *   database. CNICs, names and IBANs are stored only as HMAC-SHA256 under a pepper, so a database
 *   dump cannot be reversed by trying all 13-digit CNICs (unlike a plain hash).
 * - Peppers are versioned. After a rotation the service hashes under EVERY active version when it
 *   looks up a CNIC, so a duplicate registered under an older version is still found.
 * - Data that must be read back (the name for re-screening, the IBAN for the bank file) is sealed
 *   with AES-256-GCM. The associated data binds each ciphertext to its record, so ciphertexts
 *   cannot be swapped between records.
 */

export type HashPurpose = "cnic" | "name" | "iban";

export interface Pepper {
  version: number;
  key: Buffer;
}

export class Peppers {
  private constructor(readonly list: readonly Pepper[]) {}

  /** The first pepper is the current one; versions must be distinct, keys 32 bytes. */
  static of(list: Pepper[]): Peppers {
    if (list.length === 0) throw new Error("at least one pepper is required");
    const seen = new Set<number>();
    for (const p of list) {
      if (!Number.isInteger(p.version) || p.version < 1 || p.version > 999) throw new Error("pepper versions are integers 1..999");
      if (p.key.length !== 32) throw new Error(`pepper v${String(p.version)} must be 32 bytes`);
      if (seen.has(p.version)) throw new Error(`pepper v${String(p.version)} given twice`);
      seen.add(p.version);
    }
    return new Peppers(list.map((p) => ({ version: p.version, key: Buffer.from(p.key) })));
  }

  /**
   * Reads KYC_PEPPER_CURRENT=<n> and KYC_PEPPER_V<n>=<64 hex chars> for every active version.
   * Secret values are never echoed in errors.
   */
  static fromEnv(env: Record<string, string | undefined>): Peppers {
    const current = Number(env.KYC_PEPPER_CURRENT ?? "");
    const list: Pepper[] = [];
    for (const [k, v] of Object.entries(env)) {
      const m = /^KYC_PEPPER_V([1-9][0-9]{0,2})$/.exec(k);
      if (!m?.[1] || v === undefined) continue;
      if (!/^[0-9a-f]{64}$/.test(v)) throw new Error(`${k} must be 64 lower-case hex characters`);
      list.push({ version: Number(m[1]), key: Buffer.from(v, "hex") });
    }
    list.sort((a, b) => (a.version === current ? -1 : b.version === current ? 1 : b.version - a.version));
    if (list[0]?.version !== current) throw new Error("KYC_PEPPER_CURRENT must name a configured KYC_PEPPER_V<n> (run npm run kyc:setup)");
    return Peppers.of(list);
  }

  get current(): Pepper {
    const p = this.list[0];
    if (!p) throw new Error("no pepper");
    return p;
  }

  byVersion(version: number): Pepper {
    const p = this.list.find((x) => x.version === version);
    if (!p) throw new Error(`pepper v${String(version)} is not configured`);
    return p;
  }

  /** HMAC-SHA256 with domain separation per purpose. `value` must already be normalised. */
  hash(version: number, purpose: HashPurpose, value: string): Buffer {
    return createHmac("sha256", this.byVersion(version).key).update(`pt-${purpose}-v1\n${value}`, "utf8").digest();
  }

  /** The hash under every active version, current first (for duplicate lookups). */
  hashAll(purpose: HashPurpose, value: string): { version: number; hash: Buffer }[] {
    return this.list.map((p) => ({ version: p.version, hash: this.hash(p.version, purpose, value) }));
  }
}

const SEAL_VERSION = 1;

/** AES-256-GCM. Layout: version (1 byte) | IV (12) | ciphertext | tag (16). */
export function seal(key: Buffer, aad: string, plaintext: string): Buffer {
  if (key.length !== 32) throw new Error("sealing key must be 32 bytes");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return Buffer.concat([Buffer.from([SEAL_VERSION]), iv, body, c.getAuthTag()]);
}

/** Throws if the ciphertext, its associated data or the key is wrong. */
export function unseal(key: Buffer, aad: string, sealed: Buffer): string {
  if (key.length !== 32) throw new Error("sealing key must be 32 bytes");
  if (sealed.length < 1 + 12 + 16 || sealed[0] !== SEAL_VERSION) throw new Error("not a sealed value");
  const d = createDecipheriv("aes-256-gcm", key, sealed.subarray(1, 13));
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([d.update(sealed.subarray(13, sealed.length - 16)), d.final()]).toString("utf8");
}

/** Reads a 32-byte key given as 64 hex characters. */
export function keyFromEnv(env: Record<string, string | undefined>, name: string): Buffer {
  // eslint-disable-next-line security/detect-object-injection -- name is a fixed key chosen by our code
  const v = env[name];
  if (!v || !/^[0-9a-f]{64}$/.test(v)) throw new Error(`${name} must be 64 lower-case hex characters (run the setup command)`);
  return Buffer.from(v, "hex");
}

/** 13 digits, with or without the dashes of 12345-1234567-1. */
export function normalizeCnic(input: string): string {
  const s = input.trim();
  if (!/^(\d{13}|\d{5}-\d{7}-\d)$/.test(s)) throw new Error("CNIC must be 13 digits (12345-1234567-1)");
  return s.replaceAll("-", "");
}

/**
 * Upper case, letters only (any script), single spaces. Used for hashing the name and comparing
 * it with a bank account title, so "Ali  Khan." and "ALI KHAN" are the same.
 */
export function normalizeName(input: string): string {
  const s = input
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^\p{L}\p{M}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length < 2 || s.length > 140) throw new Error("name must have 2 to 140 letters");
  return s;
}
