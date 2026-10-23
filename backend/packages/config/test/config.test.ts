import { describe, expect, it } from "vitest";
import { isLoopbackHost, LOCAL_DEV_CHAIN_ID, loadConfig, serviceDbLogin } from "../src/index.ts";

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

describe("serviceDbLogin (T-012: fail closed)", () => {
  const admin = { PG_ADMIN_USER: "pt_admin", PG_ADMIN_PASSWORD: "admin-secret-value-0000" };
  it("uses the service's own login when both settings are present", () => {
    expect(serviceDbLogin({ ...admin, INDEXER_PG_USER: "pt_indexer_app", INDEXER_PG_PASSWORD: "p" }, "indexer")).toEqual({ user: "pt_indexer_app", password: "p", asAdmin: false });
  });
  it("refuses half a login and the admin's name as a service login", () => {
    expect(() => serviceDbLogin({ ...admin, KYC_PG_USER: "pt_kyc_app" }, "kyc")).toThrow(/must be set together/);
    expect(() => serviceDbLogin({ ...admin, KYC_PG_USER: "pt_admin", KYC_PG_PASSWORD: "x" }, "kyc")).toThrow(/not the admin/);
  });
  it("never falls back to the admin against a non-local database, nor in production, nor without the explicit flag", () => {
    expect(() => serviceDbLogin({ ...admin, PG_HOST: "db.internal", PT_DB_ADMIN_FALLBACK: "1" }, "signer")).toThrow(/non-local database/);
    expect(() => serviceDbLogin({ ...admin, NODE_ENV: "production", PT_DB_ADMIN_FALLBACK: "1" }, "signer")).toThrow(/production/);
    expect(() => serviceDbLogin({ ...admin }, "signer")).toThrow(/npm run db:service-roles/);
    // Blank values (a systemd rollback drop-in) count as unset.
    expect(serviceDbLogin({ ...admin, SIGNER_PG_USER: "", SIGNER_PG_PASSWORD: "", PT_DB_ADMIN_FALLBACK: "1" }, "signer")).toMatchObject({ user: "pt_admin", asAdmin: true });
  });
  it("names settings, never values, in its errors", () => {
    try {
      serviceDbLogin({ ...admin, PG_HOST: "10.0.0.5" }, "outbox");
    } catch (e) {
      expect((e as Error).message).not.toContain(admin.PG_ADMIN_PASSWORD);
    }
    expect(isLoopbackHost("127.0.0.1") && isLoopbackHost("localhost") && isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("127.0.0.1.example.com")).toBe(false);
  });
});
