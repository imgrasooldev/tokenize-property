import { seal, unseal } from "@pt/kyc";

/**
 * The CNIC sealing key of the tax service (ADR 0014). A separate key from the KYC data key: the
 * KYC service cannot open a sealed CNIC and the tax service cannot open a sealed name. Versioned
 * like the KYC peppers (TAX_CNIC_KEY_CURRENT=<n>, TAX_CNIC_KEY_V<n>=<64 hex>); KMS/HSM in
 * production. The associated data binds each ciphertext to its subject, to the subject's peppered
 * CNIC hash and to that hash's pepper version, so ciphertexts cannot be moved between investors.
 */
export class CnicKeys {
  private constructor(
    private readonly keys: ReadonlyMap<number, Buffer>,
    readonly current: number,
  ) {}

  static of(current: number, keys: { version: number; key: Buffer }[]): CnicKeys {
    const map = new Map<number, Buffer>();
    for (const k of keys) {
      if (!Number.isInteger(k.version) || k.version < 1 || k.version > 999) throw new Error("tax key versions are integers 1..999");
      if (k.key.length !== 32) throw new Error(`tax key v${String(k.version)} must be 32 bytes`);
      if (map.has(k.version)) throw new Error(`tax key v${String(k.version)} given twice`);
      map.set(k.version, Buffer.from(k.key));
    }
    if (!map.has(current)) throw new Error("TAX_CNIC_KEY_CURRENT must name a configured TAX_CNIC_KEY_V<n> (run npm run tax:setup)");
    return new CnicKeys(map, current);
  }

  /** Reads TAX_CNIC_KEY_CURRENT and every TAX_CNIC_KEY_V<n>. Values are never echoed. */
  static fromEnv(env: Record<string, string | undefined>): CnicKeys {
    const list: { version: number; key: Buffer }[] = [];
    for (const [k, v] of Object.entries(env)) {
      const m = /^TAX_CNIC_KEY_V([1-9][0-9]{0,2})$/.exec(k);
      if (!m?.[1] || v === undefined) continue;
      if (!/^[0-9a-f]{64}$/.test(v)) throw new Error(`${k} must be 64 lower-case hex characters`);
      list.push({ version: Number(m[1]), key: Buffer.from(v, "hex") });
    }
    return CnicKeys.of(Number(env.TAX_CNIC_KEY_CURRENT ?? ""), list);
  }

  private key(version: number): Buffer {
    const k = this.keys.get(version);
    if (!k) throw new Error(`tax key v${String(version)} is not configured`);
    return k;
  }

  seal(subject: string, cnicHash: Buffer, pepperVersion: number, cnic: string): Buffer {
    return seal(this.key(this.current), cnicAad(subject, cnicHash, pepperVersion), cnic);
  }

  /** Throws if the ciphertext, its binding or the key is wrong. */
  open(keyVersion: number, subject: string, cnicHash: Buffer, pepperVersion: number, sealed: Buffer): string {
    const cnic = unseal(this.key(keyVersion), cnicAad(subject, cnicHash, pepperVersion), sealed);
    if (!/^\d{13}$/.test(cnic)) throw new Error("a sealed CNIC did not open to 13 digits");
    return cnic;
  }
}

export function cnicAad(subject: string, cnicHash: Buffer, pepperVersion: number): string {
  return `pt-tax-cnic-v1\n${subject}\n${cnicHash.toString("hex")}\n${String(pepperVersion)}`;
}

/** 3520212345671 -> 35202-1234567-1 (the form FBR files use). */
export function formatCnic(cnic: string): string {
  if (!/^\d{13}$/.test(cnic)) throw new Error("not a CNIC");
  return `${cnic.slice(0, 5)}-${cnic.slice(5, 12)}-${cnic.slice(12)}`;
}

/** What may ever be shown or logged of a CNIC: the last four digits. */
export function maskCnic(cnic: string): string {
  const d = cnic.replace(/\D/g, "");
  return d.length === 13 ? `*****-****${d.slice(9, 12)}-${d.slice(12)}` : "*****-*******-*";
}
