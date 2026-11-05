import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DpopError, DpopVerifier, jwkThumbprint } from "../src/dpop.ts";
import { TestDpopKey } from "./dpop-keys.ts";

/** RFC 9449 proof checks (migration 0066 DP-4): what is accepted and every reason a proof is refused. */
const URL_ME = "http://51.79.144.40/v1/me";
const AT = "a".repeat(43);

describe("DPoP proofs (RFC 9449)", () => {
  it("accepts a fresh proof and returns the RFC 7638 thumbprint; the same proof twice is a replay", () => {
    const key = new TestDpopKey();
    const v = new DpopVerifier();
    const p = key.proof("GET", URL_ME, { accessToken: AT });
    expect(v.verify(p, { method: "GET", url: URL_ME, accessToken: AT })).toBe(jwkThumbprint(key.jwk));
    expect(() => v.verify(p, { method: "GET", url: URL_ME, accessToken: AT })).toThrow(/used before/);
    // The query string is not part of htu.
    expect(v.verify(key.proof("GET", URL_ME), { method: "GET", url: `${URL_ME}?limit=5` })).toHaveLength(43);
  });

  it("RFC 7638 example thumbprint", () => {
    // The RFC's example uses an RSA key; the same construction for EC must be stable and sorted.
    const jkt = jwkThumbprint({ kty: "EC", crv: "P-256", x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU", y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0" });
    expect(jkt).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(jkt).toBe(jwkThumbprint({ crv: "P-256", kty: "EC", y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0", x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU" }));
  });

  it("refuses wrong method, URL, time, access token, header, key and signature", () => {
    const key = new TestDpopKey();
    const v = new DpopVerifier();
    const now = Math.floor(Date.now() / 1000);
    const refuse = (proof: string | string[] | undefined, re: RegExp, input: { method?: string; url?: string; accessToken?: string } = {}) => {
      expect(() => v.verify(proof, { method: input.method ?? "GET", url: input.url ?? URL_ME, accessToken: input.accessToken ?? AT })).toThrow(re);
    };
    refuse(undefined, /exactly one/);
    refuse([key.proof("GET", URL_ME, { accessToken: AT }), key.proof("GET", URL_ME, { accessToken: AT })], /exactly one/);
    refuse("a.b", /compact JWS/);
    refuse(key.proof("POST", URL_ME, { accessToken: AT }), /htm/);
    refuse(key.proof("GET", "http://51.79.144.40/v1/me/holdings", { accessToken: AT }), /htu/);
    refuse(key.proof("GET", URL_ME, { accessToken: AT, iat: now - 600 }), /iat/);
    refuse(key.proof("GET", URL_ME, { accessToken: AT, iat: now + 600 }), /iat/);
    refuse(key.proof("GET", URL_ME, { accessToken: "b".repeat(43) }), /ath/);
    refuse(key.proof("GET", URL_ME), /ath/);
    refuse(key.proof("GET", URL_ME, { accessToken: AT, jti: "short" }), /jti/);
    refuse(key.proof("GET", URL_ME, { accessToken: AT, header: { typ: "JWT" } }), /typ/);
    refuse(key.proof("GET", URL_ME, { accessToken: AT, header: { alg: "HS256" } }), /alg/);
    refuse(key.proof("GET", URL_ME, { accessToken: AT, header: { jwk: { ...key.jwk, d: "secret-part" } } }), /public P-256/);
    const ed = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
    refuse(key.proof("GET", URL_ME, { accessToken: AT, header: { jwk: ed } }), /public P-256/);
    // Signed by another key than the one in the header.
    const other = new TestDpopKey();
    refuse(key.proof("GET", URL_ME, { accessToken: AT, header: { jwk: other.jwk } }), /signature/);
    const p = key.proof("GET", URL_ME, { accessToken: AT });
    refuse(`${p.slice(0, -4)}AAAA`, /signature/);
    expect(new DpopError("x")).toBeInstanceOf(Error);
  });
});
