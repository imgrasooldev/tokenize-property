import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { crc32, csvCell, sha256Hex, sha256sums, toCsv, unzipStore, zipStore, type AuditRow } from "@/lib/export";
import { age, short, utc } from "@/lib/format";
import { conflicts, permissionsOf, ROLE_CONFLICTS, ROLES } from "@/lib/permissions";
import { ROUTES } from "@/lib/routes";
import { parseFilters } from "@/lib/server/audit";
import { safeNext } from "@/lib/server/http";
import { take } from "@/lib/server/rate-limit";
import { csrfFor, hashToken, landingFor, newToken, safeEqual } from "@/lib/server/session";

const APP = join(__dirname, "..", "..", "src", "app");

function walk(dir: string): string[] {
  // Test-only walk of the source tree.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("route registry", () => {
  it("lists exactly the pages and API routes that exist under src/app", () => {
    const files = walk(APP)
      .map((p) => relative(APP, p).split(sep).join("/"))
      .filter((p) => /(^|\/)(page\.tsx|route\.ts)$/.test(p))
      .map((p) => `/${p.replace(/\/?(page\.tsx|route\.ts)$/, "")}`.replace(/\/$/, "") || "/")
      .sort();
    expect(files).toEqual(ROUTES.map((r) => r.path).sort());
  });

  it("has no server actions (every mutation is a route handler with origin + CSRF checks)", () => {
    const src = walk(join(APP, ".."));
    for (const f of src.filter((p) => /\.(ts|tsx)$/.test(p))) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      expect(readFileSync(f, "utf8"), f).not.toMatch(/["']use server["']/);
    }
  });

  it("marks every POST route as mutating and every API route except health as non-public", () => {
    for (const r of ROUTES) {
      if (r.methods.includes("POST")) expect(r.mutating, r.path).toBe(true);
      if (r.kind === "api" && r.path !== "/api/health") expect(r.access, r.path).not.toBe("public");
    }
  });
});

describe("roles", () => {
  it("conflicts are symmetric, irreflexive and sorted", () => {
    for (const [a, b] of ROLE_CONFLICTS) expect(a < b).toBe(true);
    for (const a of ROLES) {
      expect(conflicts(a, a)).toBe(false);
      for (const b of ROLES) expect(conflicts(a, b)).toBe(conflicts(b, a));
    }
  });

  it("administrators cannot read operations data and trustee officers see only the trustee view", () => {
    expect(permissionsOf(["admin"]).has("ops.read")).toBe(false);
    // Step 6d: the trustee view, its decisions and exports, and the export of the trustee audit chain only.
    expect([...permissionsOf(["trustee_officer"])].sort()).toEqual(["audit.export", "trustee.decide", "trustee.export", "trustee.read"]);
    expect(permissionsOf(["trustee_officer"]).has("approvals.decide")).toBe(false);
    expect(permissionsOf(["auditor"]).has("trustee.decide")).toBe(false);
    expect(landingFor(permissionsOf(["admin"]))).toBe("/officers");
    expect(landingFor(permissionsOf(["trustee_officer"]))).toBe("/trustee");
    expect(landingFor(permissionsOf(["ops_maker"]))).toBe("/");
  });
});

describe("tokens and CSRF", () => {
  it("tokens are 256-bit base64url, hashes are SHA-256, CSRF is bound to the session", () => {
    const t = newToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashToken(t)).toHaveLength(32);
    expect(csrfFor(t)).not.toBe(csrfFor(newToken()));
    expect(csrfFor(t)).toBe(csrfFor(t));
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  it("only our own pages are accepted as a post-sign-in target (no open redirect)", () => {
    expect(safeNext("/officers")).toBe("/officers");
    expect(safeNext("/audit/admin")).toBe("/audit/admin");
    for (const bad of ["//evil.com", "https://evil.com", "/login", "/audit/../x", "/\\evil", "javascript:alert(1)", 42, null]) {
      expect(safeNext(bad)).toBeNull();
    }
  });

  it("rate limits anonymous ceremonies per window", () => {
    const key = `t-${newToken()}`;
    let allowed = 0;
    for (let i = 0; i < 30; i++) if (take("enrol", key, 1_000)) allowed++;
    expect(allowed).toBe(10);
    expect(take("enrol", key, 62_000)).toBe(true);
  });
});

describe("audit filters", () => {
  it("drops malformed values instead of passing them on", () => {
    const f = parseFilters((k) => new Map<string, string>([
      ["from", "2026-10-01"],
      ["to", "2026-13-99x"],
      ["actor", "ops'; DROP TABLE x;--"],
      ["action", "login."],
      ["before", "0"],
    ]).get(k));
    expect(f).toEqual({ from: "2026-10-01", to: null, actor: null, action: "login.", before: null });
  });
});

describe("evidence export", () => {
  const rows: AuditRow[] = [
    { id: "2", at: "2026-10-13T00:00:00.000Z", actor: "=cmd|' /C calc'!A0", action: "login.success", ref: null, detail: { a: "x,y\"z" }, prevHash: "aa", hash: "bb" },
    { id: "1", at: "2026-10-12T00:00:00.000Z", actor: "officer", action: "page.view", ref: "r", detail: {}, prevHash: "00", hash: "aa" },
  ];

  it("CSV quotes fields and neutralises spreadsheet formulas (CSV injection)", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@x")).toBe("'@x");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    const csv = toCsv(rows);
    expect(csv.split("\r\n")[0]).toBe("id,at_utc,actor,action,ref,detail,prev_hash,hash");
    expect(csv).toContain(`'=cmd|' /C calc'!A0`);
  });

  it("CRC-32 matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("the ZIP round-trips, is deterministic, and SHA256SUMS matches the files", () => {
    const files = [
      { name: "signer-audit.csv", data: new TextEncoder().encode(toCsv(rows)) },
      { name: "manifest.json", data: new TextEncoder().encode('{"kind":"x"}\n') },
    ];
    const when = new Date("2026-10-13T07:41:02Z");
    const z1 = zipStore([...files, { name: "SHA256SUMS", data: new TextEncoder().encode(sha256sums(files)) }], when);
    const z2 = zipStore([...files, { name: "SHA256SUMS", data: new TextEncoder().encode(sha256sums(files)) }], when);
    expect(sha256Hex(z1)).toBe(sha256Hex(z2));
    const back = unzipStore(z1);
    expect([...back.keys()]).toEqual(["signer-audit.csv", "manifest.json", "SHA256SUMS"]);
    const sums = new TextDecoder().decode(back.get("SHA256SUMS"));
    for (const f of files) expect(sums).toContain(`${sha256Hex(back.get(f.name) ?? new Uint8Array())}  ${f.name}`);
    expect(() => zipStore([{ name: "../evil", data: new Uint8Array() }], when)).toThrow();
  });
});

describe("format", () => {
  it("formats ages, hashes and UTC times", () => {
    expect(age(12)).toBe("12 s");
    expect(age(600)).toBe("10 min");
    expect(age(7200)).toBe("2 h");
    expect(short("0x" + "a".repeat(64))).toBe("0xaaaaaa…aaaaaa");
    expect(utc("2026-10-13T07:41:02.123Z")).toBe("2026-10-13 07:41:02Z");
  });
});
