import { createHash, createPublicKey, verify } from "node:crypto";

/**
 * DPoP proofs, RFC 9449 (ADR 0018 amendment 7, migration 0066). The app holds a P-256 key in the
 * phone's keystore and signs a short JWT for every token request and API call; a token bound to
 * that key is useless without it.
 *
 * Checked here: one compact JWS (typ dpop+jwt, alg ES256, a public P-256 jwk and nothing private),
 * the signature, htm = the request's method, htu = the public URL of the endpoint (no query), iat
 * within the allowed skew, a jti not seen before within the proof lifetime, and for API calls ath =
 * base64url(SHA-256(access token)). The result is the key's RFC 7638 thumbprint (jkt).
 */

export class DpopError extends Error {
  override name = "DpopError";
}

export interface DpopOptions {
  now?: () => number;
  /** Accepted clock difference in seconds (both ways). */
  skewSeconds?: number;
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString("base64url");
const B64URL = /^[A-Za-z0-9_-]+$/;

/** RFC 7638 thumbprint of a P-256 public key. */
export function jwkThumbprint(jwk: { crv: string; kty: string; x: string; y: string }): string {
  return b64url(createHash("sha256").update(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`, "utf8").digest());
}

function part(s: string | undefined, what: string): Record<string, unknown> {
  if (!s || !B64URL.test(s)) throw new DpopError(`malformed ${what}`);
  try {
    const v = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("not an object");
    return v as Record<string, unknown>;
  } catch {
    throw new DpopError(`malformed ${what}`);
  }
}

export class DpopVerifier {
  private readonly now: () => number;
  private readonly skew: number;
  /** jti -> when it may be forgotten (ms). One process serves the API (demo); see ADR 0018 amendment 7. */
  private readonly seen = new Map<string, number>();

  constructor(opts: DpopOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.skew = opts.skewSeconds ?? 60;
  }

  /**
   * Checks one proof and returns its key thumbprint. `accessToken` is given for API calls (ath),
   * omitted at the token endpoint.
   */
  verify(proof: string | string[] | undefined, input: { method: string; url: string; accessToken?: string }): string {
    if (typeof proof !== "string" || proof.length > 4096) throw new DpopError("exactly one DPoP header is required");
    const segments = proof.split(".");
    if (segments.length !== 3) throw new DpopError("the proof is not a compact JWS");
    const [h, p, s] = segments as [string, string, string];
    const header = part(h, "header");
    const claims = part(p, "claims");
    if (header.typ !== "dpop+jwt") throw new DpopError("typ must be dpop+jwt");
    if (header.alg !== "ES256") throw new DpopError("alg must be ES256");
    const jwk = header.jwk as Record<string, unknown> | undefined;
    if (
      typeof jwk !== "object" ||
      jwk.kty !== "EC" ||
      jwk.crv !== "P-256" ||
      typeof jwk.x !== "string" ||
      typeof jwk.y !== "string" ||
      !B64URL.test(jwk.x) ||
      !B64URL.test(jwk.y) ||
      "d" in jwk
    ) {
      throw new DpopError("jwk must be a public P-256 key");
    }
    const key = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
    let ok: boolean;
    try {
      ok = verify("sha256", Buffer.from(`${h}.${p}`, "ascii"), { key: createPublicKey({ key, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
    } catch {
      throw new DpopError("the jwk or the signature is not valid");
    }
    if (!ok) throw new DpopError("the signature does not match");

    if (typeof claims.jti !== "string" || claims.jti.length < 8 || claims.jti.length > 128) throw new DpopError("jti is required (8-128 characters)");
    if (claims.htm !== input.method) throw new DpopError("htm does not match the request method");
    if (typeof claims.htu !== "string" || stripQuery(claims.htu) !== stripQuery(input.url)) throw new DpopError("htu does not match the request URL");
    const nowSeconds = Math.floor(this.now() / 1000);
    if (typeof claims.iat !== "number" || !Number.isInteger(claims.iat) || Math.abs(nowSeconds - claims.iat) > this.skew) throw new DpopError("iat is too old or in the future");
    if (input.accessToken !== undefined) {
      const ath = b64url(createHash("sha256").update(input.accessToken, "ascii").digest());
      if (claims.ath !== ath) throw new DpopError("ath does not match the access token");
    }
    const jkt = jwkThumbprint(key);
    this.remember(`${jkt}:${claims.jti}`, (claims.iat + this.skew * 2) * 1000);
    return jkt;
  }

  private remember(id: string, until: number): void {
    const t = this.now();
    if (this.seen.size > 10_000) for (const [k, v] of this.seen) if (v <= t) this.seen.delete(k);
    const known = this.seen.get(id);
    if (known !== undefined && known > t) throw new DpopError("this proof was used before (jti)");
    this.seen.set(id, until);
  }
}

function stripQuery(u: string): string {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host.toLowerCase()}${x.pathname}`;
  } catch {
    return "";
  }
}
