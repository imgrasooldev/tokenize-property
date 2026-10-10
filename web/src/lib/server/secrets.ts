import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function secret(name: "WEB_SESSION_SECRET" | "WEB_WALLET_KEY" | "WEB_CNIC_PEPPER"): Buffer {
  // eslint-disable-next-line security/detect-object-injection -- fixed literal union of names
  const value = process.env[name];
  if (!value || value.length < 40) {
    throw new Error(`${name} is missing. Run \`npm run setup:demo\` in web/.`);
  }
  return Buffer.from(value, "base64url");
}

/** AES-256-GCM. Output: iv(12) | tag(16) | ciphertext. */
export function encrypt(plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secret("WEB_WALLET_KEY"), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function decrypt(blob: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", secret("WEB_WALLET_KEY"), blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString("utf8");
}

export function hmac(purpose: "session" | "cnic", data: string): string {
  const key = purpose === "session" ? secret("WEB_SESSION_SECRET") : secret("WEB_CNIC_PEPPER");
  return createHmac("sha256", key).update(data).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
