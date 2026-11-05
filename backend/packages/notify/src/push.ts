import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import { ContactError } from "./crypto.ts";

/**
 * Push device tokens (migration 0065 PN-2). The public API seals a token for the notification
 * worker only: an ephemeral X25519 key agreement with the worker's public key, HKDF-SHA256 and
 * AES-256-GCM, bound by its associated data to the recipient and the lookup hash. The API holds
 * only the public key (NOTIFY_PUSH_PUBLIC_KEY) and cannot open what it sealed; the worker holds the
 * private key (NOTIFY_PUSH_PRIVATE_KEY). Both are base64 DER (SPKI / PKCS#8).
 *
 * Sealed layout: version byte 1 | ephemeral public key (SPKI DER, 44 bytes) | IV (12) | tag (16) | ciphertext.
 */

/** FCM / APNs registration tokens: printable, no spaces, 20-256 characters. */
export const PUSH_TOKEN = /^[A-Za-z0-9:_\-.]{20,256}$/;

const VERSION = 1;
const SPKI_LEN = 44;

export function pushLookupHash(token: string): Buffer {
  return createHash("sha256").update(`pt-notify-push-v1\n${token}`, "utf8").digest();
}

function aad(recipientId: string, lookupHash: Buffer): Buffer {
  return Buffer.from(`pt-notify-push-v1|${recipientId}|${lookupHash.toString("hex")}`, "utf8");
}

function aesKey(shared: Buffer, ephemeral: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, ephemeral, "pt-notify-push-seal-v1", 32));
}

function keyFrom(env: Record<string, string | undefined>, name: string, kind: "public" | "private"): KeyObject {
  // eslint-disable-next-line security/detect-object-injection -- fixed variable names
  const raw = env[name];
  if (!raw) throw new ContactError(`${name} is not set`);
  try {
    const der = Buffer.from(raw, "base64");
    const key = kind === "public" ? createPublicKey({ key: der, format: "der", type: "spki" }) : createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "x25519") throw new Error("not x25519");
    return key;
  } catch {
    throw new ContactError(`${name} is not a base64 DER X25519 key`);
  }
}

/** A new key pair for `notify:setup` (local development) or the KMS import. */
export function newPushKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
}

/** The public API's side: seals only. */
export class PushSealer {
  private constructor(private readonly publicKey: KeyObject) {}

  static fromEnv(env: Record<string, string | undefined>): PushSealer {
    return new PushSealer(keyFrom(env, "NOTIFY_PUSH_PUBLIC_KEY", "public"));
  }

  seal(recipientId: string, token: string): { lookupHash: Buffer; sealed: Buffer } {
    if (!PUSH_TOKEN.test(token)) throw new ContactError("push token is not valid");
    const lookupHash = pushLookupHash(token);
    const eph = generateKeyPairSync("x25519");
    const ephPublic = eph.publicKey.export({ format: "der", type: "spki" });
    const key = aesKey(diffieHellman({ privateKey: eph.privateKey, publicKey: this.publicKey }), ephPublic);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad(recipientId, lookupHash));
    const ct = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return { lookupHash, sealed: Buffer.concat([Buffer.from([VERSION]), ephPublic, iv, cipher.getAuthTag(), ct]) };
  }
}

/** The worker's side: opens a push contact and checks it against its lookup hash. */
export class PushOpener {
  private constructor(private readonly privateKey: KeyObject) {}

  static fromEnv(env: Record<string, string | undefined>): PushOpener {
    return new PushOpener(keyFrom(env, "NOTIFY_PUSH_PRIVATE_KEY", "private"));
  }

  open(recipientId: string, lookupHash: Buffer, sealed: Buffer): string {
    let token: string;
    try {
      if (sealed.length < 1 + SPKI_LEN + 12 + 16 + 20 || sealed[0] !== VERSION) throw new Error("layout");
      const ephPublic = sealed.subarray(1, 1 + SPKI_LEN);
      const iv = sealed.subarray(1 + SPKI_LEN, 1 + SPKI_LEN + 12);
      const tag = sealed.subarray(1 + SPKI_LEN + 12, 1 + SPKI_LEN + 28);
      const ct = sealed.subarray(1 + SPKI_LEN + 28);
      const shared = diffieHellman({ privateKey: this.privateKey, publicKey: createPublicKey({ key: ephPublic, format: "der", type: "spki" }) });
      const decipher = createDecipheriv("aes-256-gcm", aesKey(shared, ephPublic), iv);
      decipher.setAAD(aad(recipientId, lookupHash));
      decipher.setAuthTag(tag);
      token = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    } catch {
      throw new ContactError("push token cannot be opened (wrong key, or the row was altered or moved)");
    }
    const check = pushLookupHash(token);
    if (check.length !== lookupHash.length || !timingSafeEqual(check, lookupHash)) throw new ContactError("push token does not match its lookup hash");
    return token;
  }
}
