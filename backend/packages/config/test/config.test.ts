import { describe, expect, it } from "vitest";
import { LOCAL_DEV_CHAIN_ID, loadConfig } from "../src/index.ts";

const base = {
  PG_HOST: "127.0.0.1",
  PG_PORT: "5433",
  PG_DATABASE: "property_token",
  PG_USER: "pt_app",
  PG_PASSWORD: "a-long-generated-password-123",
};

describe("loadConfig", () => {
  it("parses a valid development config with safe defaults", () => {
    const c = loadConfig(base);
    expect(c.PG_PORT).toBe(5433);
    expect(c.CHAIN_ID).toBe(LOCAL_DEV_CHAIN_ID);
    expect(c.NODE_ENV).toBe("development");
    expect(Object.isFrozen(c)).toBe(true);
  });

  it("never echoes secret values in validation errors", () => {
    const secret = "short-secret";
    expect(() => loadConfig({ ...base, PG_PASSWORD: secret })).toThrow(/PG_PASSWORD/);
    try {
      loadConfig({ ...base, PG_PASSWORD: secret });
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });

  it("refuses the local dev chain ID and plaintext DB connections in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production", PG_SSL: "require" })).toThrow(/local dev chain ID/);
    expect(() => loadConfig({ ...base, NODE_ENV: "production", CHAIN_ID: "586587" })).toThrow(/TLS/);
    expect(loadConfig({ ...base, NODE_ENV: "production", CHAIN_ID: "586587", PG_SSL: "require" }).CHAIN_ID).toBe(586_587);
  });

  it("rejects injection-shaped database names", () => {
    expect(() => loadConfig({ ...base, PG_DATABASE: "x; DROP DATABASE y" })).toThrow(/PG_DATABASE/);
  });
});
