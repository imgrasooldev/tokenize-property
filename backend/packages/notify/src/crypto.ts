import { createHmac, timingSafeEqual } from "node:crypto";
import { keyFromEnv, seal, unseal } from "@pt/kyc";

/**
 * Contact details (rule N-1). The database never holds a readable phone number or e-mail address:
 * - lookup: HMAC-SHA256 under NOTIFY_LOOKUP_KEY with domain separation per channel (a plain hash of
 *   a Pakistani mobile number could be reversed by trying all ~10^10 numbers);
 * - sealed: AES-256-GCM under NOTIFY_DATA_KEY (the same construction as KYC sealing, ADR 0009),
 *   bound by its associated data to the recipient, the channel and the lookup hash, so a sealed
 *   value copied to another recipient or channel does not open.
 * Both keys live outside the database (KMS/HSM in production; `npm run notify:setup` for local dev).
 */

export type ContactChannel = "sms" | "email";

export class ContactError extends Error {
  override name = "ContactError";
}

/**
 * E.164. Pakistani mobile numbers may be given as 03XXXXXXXXX, 923XXXXXXXXX, 00923... or +923...;
 * other international numbers need the + or 00 prefix. Spaces, dashes and brackets are ignored.
 */
export function normalizePhone(input: string): string {
  let s = input.trim().replace(/[\s\-()]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  if (/^03[0-9]{9}$/.test(s)) s = `+92${s.slice(1)}`;
  else if (/^923[0-9]{9}$/.test(s)) s = `+${s}`;
  if (!/^\+[1-9][0-9]{7,14}$/.test(s)) throw new ContactError("phone number must be a mobile number such as 03001234567 or +923001234567");
  if (s.startsWith("+92") && !/^\+923[0-9]{9}$/.test(s)) throw new ContactError("a Pakistani number must be a mobile number (+923XXXXXXXXX)");
  return s;
}

/** Lower case (lookups must not depend on how the address was typed), NFKC, trimmed. */
export function normalizeEmail(input: string): string {
  const s = input.normalize("NFKC").trim().toLowerCase();
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (s.length > 254 || !/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(s) || /[\u0000-\u001f\u007f<>,;"]/.test(s)) {
    throw new ContactError("e-mail address is not valid");
  }
  return s;
}

export function normalizeContact(channel: ContactChannel, value: string): string {
  return channel === "sms" ? normalizePhone(value) : normalizeEmail(value);
}

/** What the worker receives from notify.delivery_material for one contact. */
export interface SealedContact {
  recipientId: string;
  channel: ContactChannel;
  lookupHash: Buffer;
  sealed: Buffer;
  keyVersion: number;
}

export class ContactSecrets {
  private constructor(
    private readonly dataKey: Buffer,
    private readonly lookupKey: Buffer,
    readonly keyVersion: number,
  ) {}

  static of(dataKey: Buffer, lookupKey: Buffer, keyVersion = 1): ContactSecrets {
    if (dataKey.length !== 32 || lookupKey.length !== 32) throw new ContactError("notify keys must be 32 bytes");
    if (dataKey.equals(lookupKey)) throw new ContactError("the sealing key and the lookup key must differ");
    if (!Number.isInteger(keyVersion) || keyVersion < 1 || keyVersion > 999) throw new ContactError("key version must be 1..999");
    return new ContactSecrets(Buffer.from(dataKey), Buffer.from(lookupKey), keyVersion);
  }

  /** NOTIFY_DATA_KEY and NOTIFY_LOOKUP_KEY (64 hex characters each); values are never echoed. */
  static fromEnv(env: Record<string, string | undefined>): ContactSecrets {
    return ContactSecrets.of(keyFromEnv(env, "NOTIFY_DATA_KEY"), keyFromEnv(env, "NOTIFY_LOOKUP_KEY"));
  }

  /** HMAC of a NORMALISED value, separated by channel. */
  lookupHash(channel: ContactChannel, normalized: string): Buffer {
    return createHmac("sha256", this.lookupKey).update(`pt-notify-${channel}-v1\n${normalized}`, "utf8").digest();
  }

  private static aad(recipientId: string, channel: ContactChannel, lookupHash: Buffer): string {
    return `pt-notify-contact-v1|${recipientId}|${channel}|${lookupHash.toString("hex")}`;
  }

  /** Normalises, hashes and seals a contact for notify.register_contact. */
  protect(recipientId: string, channel: ContactChannel, value: string): { lookupHash: Buffer; sealed: Buffer; keyVersion: number } {
    const normalized = normalizeContact(channel, value);
    const lookupHash = this.lookupHash(channel, normalized);
    return { lookupHash, sealed: seal(this.dataKey, ContactSecrets.aad(recipientId, channel, lookupHash), normalized), keyVersion: this.keyVersion };
  }

  /**
   * Opens a sealed contact and checks it still matches its lookup hash (a tampered or swapped row
   * fails here and the delivery goes to the dead letters instead of reaching a stranger).
   */
  open(c: SealedContact): string {
    if (c.keyVersion !== this.keyVersion) throw new ContactError(`contact sealed under key version ${String(c.keyVersion)}, which is not configured`);
    let value: string;
    try {
      value = unseal(this.dataKey, ContactSecrets.aad(c.recipientId, c.channel, c.lookupHash), c.sealed);
    } catch {
      throw new ContactError("contact cannot be opened (wrong key, or the row was altered or moved)");
    }
    const check = this.lookupHash(c.channel, value);
    if (check.length !== c.lookupHash.length || !timingSafeEqual(check, c.lookupHash)) {
      throw new ContactError("contact does not match its lookup hash");
    }
    return value;
  }
}
