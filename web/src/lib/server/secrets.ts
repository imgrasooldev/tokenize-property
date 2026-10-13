import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The website's own secrets (web/.env.local): session signing and the CNIC uniqueness pepper. Since
 * Step 5h it holds no wallet key at all (custody is in the signing service, ADR 0010).
 */
function secret(name: "WEB_SESSION_SECRET" | "WEB_CNIC_PEPPER"): Buffer {
  // eslint-disable-next-line security/detect-object-injection -- fixed literal union of names
  const value = process.env[name];
  if (!value || value.length < 40) {
    throw new Error(`${name} is missing. Run \`npm run setup:demo\` in web/.`);
  }
  return Buffer.from(value, "base64url");
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
