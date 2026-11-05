import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";

/** A test app key (P-256) that signs DPoP proofs the way the app will (RFC 9449). */
export class TestDpopKey {
  readonly privateKey: KeyObject;
  readonly jwk: { kty: string; crv: string; x: string; y: string };

  constructor() {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = pair.privateKey;
    const j = pair.publicKey.export({ format: "jwk" });
    this.jwk = { kty: String(j.kty), crv: String(j.crv), x: String(j.x), y: String(j.y) };
  }

  proof(
    htm: string,
    htu: string,
    opts: { accessToken?: string; iat?: number; jti?: string; header?: Record<string, unknown>; claims?: Record<string, unknown> } = {},
  ): string {
    const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
    const header = { typ: "dpop+jwt", alg: "ES256", jwk: this.jwk, ...opts.header };
    const claims = {
      jti: opts.jti ?? randomUUID(),
      htm,
      htu,
      iat: opts.iat ?? Math.floor(Date.now() / 1000),
      ...(opts.accessToken === undefined ? {} : { ath: createHash("sha256").update(opts.accessToken, "ascii").digest("base64url") }),
      ...opts.claims,
    };
    const input = `${enc(header)}.${enc(claims)}`;
    return `${input}.${sign("sha256", Buffer.from(input), { key: this.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  }
}
