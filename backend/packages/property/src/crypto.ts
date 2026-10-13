import { createHmac } from "node:crypto";
import { keyFromEnv, Peppers, seal, unseal } from "@pt/kyc";

/**
 * Sponsor data protection (migration 0014 PR-1), with the same primitives as @pt/kyc (ADR 0009 Y-1)
 * but separate secrets, so a leak of one domain's keys does not open the other:
 *   PROPERTY_PEPPER_V<n> / PROPERTY_PEPPER_CURRENT  keyed hashes of registration numbers (CUIN, NTN, STRN)
 *   PROPERTY_DATA_KEY                              AES-256-GCM sealing of the legal name and address
 * An individual's NTN is their CNIC, so registration numbers are never stored in readable form.
 */

export type RegistrationKind = "cuin" | "ntn" | "strn";

export interface SponsorSecretsEnv {
  [key: string]: string | undefined;
}

/** Upper case, letters and digits only ("0012345-6" and "00123456" are the same NTN). */
export function normalizeRegistration(kind: RegistrationKind, input: string): string {
  const s = input.normalize("NFKC").toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (s.length < 5 || s.length > 20) throw new Error(`${kind.toUpperCase()} must have 5 to 20 letters or digits`);
  return s;
}

export class SponsorSecrets {
  constructor(
    readonly peppers: Peppers,
    private readonly dataKey: Buffer,
  ) {
    if (dataKey.length !== 32) throw new Error("PROPERTY_DATA_KEY must be 32 bytes");
  }

  static fromEnv(env: SponsorSecretsEnv): SponsorSecrets {
    const current = Number(env.PROPERTY_PEPPER_CURRENT ?? "");
    const list: { version: number; key: Buffer }[] = [];
    for (const [k, v] of Object.entries(env)) {
      const m = /^PROPERTY_PEPPER_V([1-9][0-9]{0,2})$/.exec(k);
      if (!m?.[1] || v === undefined) continue;
      if (!/^[0-9a-f]{64}$/.test(v)) throw new Error(`${k} must be 64 lower-case hex characters`);
      list.push({ version: Number(m[1]), key: Buffer.from(v, "hex") });
    }
    list.sort((a, b) => (a.version === current ? -1 : b.version === current ? 1 : b.version - a.version));
    if (list[0]?.version !== current) throw new Error("PROPERTY_PEPPER_CURRENT must name a configured PROPERTY_PEPPER_V<n> (run npm run property:setup)");
    return new SponsorSecrets(Peppers.of(list), keyFromEnv(env, "PROPERTY_DATA_KEY"));
  }

  /** HMAC-SHA256 under every active pepper, current first (for duplicate lookups after a rotation). */
  hashAll(kind: RegistrationKind, value: string): { version: number; hash: Buffer }[] {
    const v = normalizeRegistration(kind, value);
    return this.peppers.list.map((p) => ({
      version: p.version,
      hash: createHmac("sha256", p.key).update(`pt-property-${kind}-v1\n${v}`, "utf8").digest(),
    }));
  }

  seal(sponsorId: string, field: "name" | "address", value: string): Buffer {
    return seal(this.dataKey, aad(sponsorId, field), value);
  }

  unseal(sponsorId: string, field: "name" | "address", sealed: Buffer): string {
    return unseal(this.dataKey, aad(sponsorId, field), sealed);
  }
}

const aad = (sponsorId: string, field: string): string => `pt-property-sponsor-v1:${sponsorId}:${field}`;
