import { describe, expect, it } from "vitest";
import { PASSKEY_DICTS, passkeyDict, passkeyError } from "../src/lib/i18n-passkey";
import { ceremonyError, credentialIdOk, passkeyNameSchema, responseShapeOk, stepUpResult, type PasskeyError } from "../src/lib/passkey-rules";
import { passkeyConfigFrom } from "../src/lib/server/passkey-config";

describe("where passkeys can work (WEB_ORIGIN)", () => {
  it("needs https or localhost, and never an IP address", () => {
    expect(passkeyConfigFrom({ WEB_ORIGIN: "https://app.example.pk" })).toEqual({
      enabled: true,
      origin: "https://app.example.pk",
      host: "app.example.pk",
      rpID: "app.example.pk",
      rpName: "Property Token",
    });
    expect(passkeyConfigFrom({ WEB_ORIGIN: "http://localhost:3102" })).toMatchObject({ enabled: true, rpID: "localhost", host: "localhost:3102" });
    expect(passkeyConfigFrom({ WEB_ORIGIN: "http://pt.localhost:3100" })).toMatchObject({ enabled: true, rpID: "pt.localhost" });
    // The demo server today: plain HTTP by IP address.
    expect(passkeyConfigFrom({ WEB_ORIGIN: "http://51.79.144.40", NODE_ENV: "production" })).toEqual({ enabled: false, reason: "insecure" });
    expect(passkeyConfigFrom({ WEB_ORIGIN: "https://51.79.144.40" })).toEqual({ enabled: false, reason: "insecure" });
    expect(passkeyConfigFrom({ WEB_ORIGIN: "http://127.0.0.1:3100" })).toEqual({ enabled: false, reason: "insecure" });
    expect(passkeyConfigFrom({ WEB_ORIGIN: "http://[::1]:3100" })).toEqual({ enabled: false, reason: "insecure" });
    expect(passkeyConfigFrom({ WEB_ORIGIN: "http://app.example.pk" })).toEqual({ enabled: false, reason: "insecure" });
  });

  it("is off in production without WEB_ORIGIN, localhost:3100 in development, and refuses anything but an origin", () => {
    expect(passkeyConfigFrom({ NODE_ENV: "production" })).toEqual({ enabled: false, reason: "unset" });
    expect(passkeyConfigFrom({ NODE_ENV: "development" })).toMatchObject({ enabled: true, origin: "http://localhost:3100" });
    expect(passkeyConfigFrom({ WEB_ORIGIN: "https://app.example.pk/login" })).toEqual({ enabled: false, reason: "unset" });
    expect(passkeyConfigFrom({ WEB_ORIGIN: "https://user:pw@app.example.pk" })).toEqual({ enabled: false, reason: "unset" });
    expect(passkeyConfigFrom({ WEB_ORIGIN: "not a url" })).toEqual({ enabled: false, reason: "unset" });
  });
});

describe("passkey input rules", () => {
  it("passkey labels match the database rule (webauth.name_ok)", () => {
    for (const ok of ["My phone", "Laptop (work)", "میرا فون", "YubiKey 5C"]) expect(passkeyNameSchema.safeParse(ok).success).toBe(true);
    for (const bad of ["", "x".repeat(41), "<b>", 'say "hi"', "CNIC 3520212345671", "0300 1234567", "tab\there"]) {
      expect(passkeyNameSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("checks the response shape before verification", () => {
    const good = { id: "A".repeat(43), rawId: "A".repeat(43), type: "public-key", response: { clientDataJSON: "x" } };
    expect(responseShapeOk(good)).toBe(true);
    expect(responseShapeOk({ ...good, rawId: "B".repeat(43) })).toBe(false);
    expect(responseShapeOk({ ...good, type: "password" })).toBe(false);
    expect(responseShapeOk({ ...good, id: "short" })).toBe(false);
    expect(responseShapeOk({ ...good, response: null })).toBe(false);
    expect(responseShapeOk({ ...good, response: { big: "x".repeat(40_000) } })).toBe(false);
    expect(responseShapeOk([good])).toBe(false);
    expect(responseShapeOk(null)).toBe(false);
    expect(credentialIdOk("abc_-".repeat(4))).toBe(true);
    expect(credentialIdOk("has space in the id")).toBe(false);
  });

  it("maps the database's answers", () => {
    expect(ceremonyError("step_up")).toBe("stepup");
    expect(ceremonyError("ceremony")).toBe("expired");
    expect(ceremonyError("uv")).toBe("verify");
    expect(ceremonyError("locked")).toBe("locked");
    expect(ceremonyError("something new")).toBe("generic");
    expect(ceremonyError(undefined)).toBe("generic");
    expect(stepUpResult("ok")).toEqual({ ok: true });
    expect(stepUpResult("waived")).toEqual({ ok: true });
    expect(stepUpResult("step_up")).toEqual({ ok: false, error: "stepup" });
    expect(stepUpResult("enrol")).toEqual({ ok: false, error: "enrolPasskey" });
    expect(stepUpResult("session")).toEqual({ ok: false, error: "session" });
    expect(stepUpResult(undefined)).toEqual({ ok: false, error: "session" });
  });
});

describe("passkey texts (English and Urdu)", () => {
  it("have the same keys, none empty, and a message for every error", () => {
    expect(Object.keys(PASSKEY_DICTS.ur).sort()).toEqual(Object.keys(PASSKEY_DICTS.en).sort());
    for (const d of [PASSKEY_DICTS.en, PASSKEY_DICTS.ur]) for (const v of Object.values(d)) expect(v.trim().length).toBeGreaterThan(0);
    const errors: PasskeyError[] = ["unavailable", "unsupported", "cancelled", "rate", "session", "reauth", "reauthStepUp", "limit", "locked", "busy", "none", "expired", "verify", "refused", "name", "duplicate", "stepup", "unknown", "generic"];
    for (const lang of ["en", "ur"] as const) for (const e of errors) expect(passkeyError(passkeyDict(lang), e).length).toBeGreaterThan(5);
    expect(PASSKEY_DICTS.en.unavailable).toContain("domain + TLS");
  });
});
