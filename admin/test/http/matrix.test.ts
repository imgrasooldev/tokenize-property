import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { request } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfFor } from "@/lib/server/session";
import { ROUTES } from "@/lib/routes";
import { sha256Hex, unzipStore } from "@/lib/export";
import { freezePayouts, passRecon, payoutBatch, pendingMint, startTestSigner, type TestSigner } from "../support/approvals";
import { caseOf, freezePolicies, investor } from "../support/compliance";
import { operationsWorld } from "../support/operations";
import { cast, createWorld, invite, type Actor, type Cast, type World } from "../support/world";

/**
 * Authorisation matrix over real HTTP against the production build (`npm run build` first): every
 * route × every role, anonymous visitors and an investor website cookie; CSRF and same-origin
 * checks on every mutating route; session expiry; security headers. Expectations are written out
 * below, independently of src/lib/routes.ts.
 */
const PORT = 3399;
const ORIGIN = `http://localhost:${String(PORT)}`;
const COOKIE = "__Host-pt_admin";
type Role = "ops_maker" | "ops_checker" | "compliance_officer" | "trustee_officer" | "tax_officer" | "auditor" | "admin";
type Who = Role | "anonymous" | "investor";
const ROLES: Role[] = ["ops_maker", "ops_checker", "compliance_officer", "trustee_officer", "tax_officer", "auditor", "admin"];
const EVERYONE: Who[] = [...ROLES, "anonymous", "investor"];
const OPS: Role[] = ["ops_maker", "ops_checker", "compliance_officer", "auditor"];

const APPROVALS: Role[] = ["ops_maker", "ops_checker", "auditor"];
const PROPERTY: Role[] = ["ops_maker", "ops_checker", "compliance_officer", "auditor"];
const COMPLIANCE: Role[] = ["compliance_officer", "auditor"];
const OPERATIONS: Role[] = ["ops_maker", "ops_checker", "trustee_officer", "tax_officer", "auditor"];
const TAX: Role[] = ["tax_officer", "auditor"];

/**
 * Who gets the page (200, or the documented redirect); everyone else 403, visitors -> /login.
 * {signer}, {payout} and {unfreeze} are items created in beforeAll.
 */
const PAGES: { path: string; allowed: Role[]; okStatus?: number }[] = [
  { path: "/", allowed: OPS },
  { path: "/account", allowed: ROLES },
  { path: "/audit", allowed: ["ops_maker", "ops_checker", "compliance_officer", "auditor", "admin"], okStatus: 307 },
  { path: "/audit/signer", allowed: OPS },
  { path: "/audit/recon", allowed: OPS },
  { path: "/audit/ledger", allowed: OPS },
  { path: "/audit/admin", allowed: ["compliance_officer", "auditor", "admin"] },
  { path: "/officers", allowed: ["auditor", "admin"] },
  { path: "/approvals", allowed: APPROVALS },
  { path: "/approvals/signer/{signer}", allowed: APPROVALS },
  { path: "/approvals/payouts/{payout}", allowed: APPROVALS },
  { path: "/approvals/unfreeze/{unfreeze}", allowed: APPROVALS },
  { path: "/approvals/property", allowed: PROPERTY },
  // Authorised readers get "not found" for an unknown request (the database answers NULL).
  { path: "/approvals/property/999999", allowed: PROPERTY, okStatus: 404 },
  { path: "/compliance", allowed: COMPLIANCE },
  // Step 6c: compliance officers and auditors only (operations never); unknown items are "not found".
  { path: "/audit/compliance", allowed: COMPLIANCE },
  { path: "/compliance/kyc", allowed: COMPLIANCE },
  { path: "/compliance/kyc/{kycCase}", allowed: COMPLIANCE },
  { path: "/compliance/kyc/999999", allowed: COMPLIANCE, okStatus: 404 },
  { path: "/compliance/screening", allowed: COMPLIANCE },
  { path: "/compliance/freezes", allowed: COMPLIANCE },
  { path: "/compliance/freezes/{freeze}", allowed: COMPLIANCE },
  { path: "/compliance/str", allowed: COMPLIANCE },
  { path: "/compliance/str/{str}", allowed: COMPLIANCE },
  { path: "/trustee", allowed: ["trustee_officer", "auditor"] },
  // S-03 (migration 0021): operations for makers, checkers, the trustee, tax officers and auditors; tax for tax officers and auditors.
  { path: "/operations", allowed: OPERATIONS },
  { path: "/operations/charges/{charge}", allowed: OPERATIONS },
  { path: "/operations/charges/999999", allowed: OPERATIONS, okStatus: 404 },
  { path: "/operations/distributions/{distribution}", allowed: OPERATIONS },
  { path: "/tax", allowed: TAX },
  { path: "/tax/exports", allowed: TAX },
  { path: "/tax/exports/{taxExport}", allowed: TAX },
];

/** Session-protected POST routes: who passes authorisation, and the status they then get. */
const APIS: { path: string; allowed: Role[]; okStatus: number; form?: Record<string, string>; json?: boolean }[] = [
  // JSON routes called by fetch(): the CSRF token travels in the x-csrf-token header.
  { path: "/api/auth/stepup/options", allowed: ROLES, okStatus: 200, json: true },
  { path: "/api/auth/stepup/verify", allowed: ROLES, okStatus: 400, json: true },
  { path: "/api/audit/signer/export", allowed: ["compliance_officer", "auditor"], okStatus: 200, form: { format: "csv" } },
  { path: "/api/audit/recon/export", allowed: ["compliance_officer", "auditor"], okStatus: 200, form: { format: "json" } },
  { path: "/api/audit/ledger/export", allowed: ["compliance_officer", "auditor"], okStatus: 200, form: { format: "csv" } },
  { path: "/api/audit/admin/export", allowed: ["compliance_officer", "auditor"], okStatus: 200, form: { format: "json" } },
  { path: "/api/officers/changes", allowed: ["admin"], okStatus: 303, form: { kind: "invite", reason: "too short" } },
  { path: "/api/officers/changes/1/decide", allowed: ["admin"], okStatus: 303, form: { decision: "approve", reason: "matrix test" } },
  // Step 6b: an incomplete decision is answered with a 303 back to the item (nothing decided).
  { path: "/api/approvals/signer/{signer}/decide", allowed: ["ops_checker"], okStatus: 303, form: { decision: "approve", reason: "short" } },
  { path: "/api/approvals/payouts/{payout}/decide", allowed: ["ops_checker"], okStatus: 303, form: { decision: "approve", reason: "short" } },
  { path: "/api/approvals/unfreeze", allowed: ["ops_maker"], okStatus: 303, form: { reason: "short" } },
  { path: "/api/approvals/unfreeze/{unfreeze}/decide", allowed: ["ops_checker"], okStatus: 303, form: { decision: "approve", reason: "short" } },
  { path: "/api/approvals/property/1/decide", allowed: ["ops_checker", "compliance_officer"], okStatus: 303, form: { decision: "approve", reason: "short" } },
  // Step 6c: compliance officers only; an incomplete form (or a missing step-up) is answered with a 303 back (nothing decided).
  { path: "/api/audit/compliance/export", allowed: COMPLIANCE, okStatus: 200, form: { format: "csv" } },
  { path: "/api/compliance/kyc", allowed: ["compliance_officer"], okStatus: 303, form: { summary: "short" } },
  { path: "/api/compliance/kyc/{kycCase}/act", allowed: ["compliance_officer"], okStatus: 303, form: { decision: "approve", reason: "short" } },
  { path: "/api/compliance/rescreen", allowed: ["compliance_officer"], okStatus: 303, form: { reason: "short" } },
  { path: "/api/compliance/freezes", allowed: ["compliance_officer"], okStatus: 303, form: { kind: "freeze" } },
  { path: "/api/compliance/freezes/{freeze}/decide", allowed: ["compliance_officer"], okStatus: 303, form: { decision: "approve", reason: "short" } },
  { path: "/api/compliance/str", allowed: ["compliance_officer"], okStatus: 303, form: { summary: "short" } },
  { path: "/api/compliance/str/{str}/notes", allowed: ["compliance_officer"], okStatus: 303, form: {} },
  { path: "/api/compliance/str/{str}/act", allowed: ["compliance_officer"], okStatus: 303, form: { decision: "start_review", reason: "short" } },
  // Without the export button (and a fresh step-up, checked by the database) no file is made: 303 back.
  { path: "/api/compliance/str/{str}/export", allowed: ["compliance_officer"], okStatus: 303, form: {} },
  // S-03: an incomplete form (or a missing step-up, or no generate button) is answered with a 303 back (nothing done).
  { path: "/api/operations/charges", allowed: ["ops_maker"], okStatus: 303, form: {} },
  { path: "/api/operations/charges/{charge}/decide", allowed: ["ops_checker"], okStatus: 303, form: { decision: "approve", reason: "short" } },
  { path: "/api/operations/distributions/{distribution}/decide", allowed: ["ops_checker"], okStatus: 303, form: { decision: "approve", reason: "short" } },
  { path: "/api/tax/rates", allowed: ["tax_officer"], okStatus: 303, form: {} },
  { path: "/api/tax/rates/{taxRate}/decide", allowed: ["tax_officer"], okStatus: 303, form: { decision: "approve", reason: "short" } },
  { path: "/api/tax/exports", allowed: ["tax_officer"], okStatus: 303, form: {} },
  { path: "/api/tax/exports/{taxExport}/decide", allowed: ["tax_officer"], okStatus: 303, form: { decision: "approve", reason: "short" } },
  { path: "/api/tax/exports/{taxExport}/generate", allowed: ["tax_officer"], okStatus: 303, form: {} },
];

/** The role that may use a mutating route (CSRF tests use it, so a refusal is the CSRF check's own). */
function userOf(path: string): Role {
  if (path.includes("officers")) return "admin";
  if (path.startsWith("/api/compliance/")) return "compliance_officer";
  if (path.startsWith("/api/tax/")) return "tax_officer";
  if (path.startsWith("/api/operations/") && path.endsWith("/decide")) return "ops_checker";
  if (path.includes("export")) return "auditor";
  if (path.includes("/approvals/property/")) return "compliance_officer";
  if (path.endsWith("/decide") && path.includes("/approvals/")) return "ops_checker";
  return "ops_maker";
}

/** Anonymous ceremonies: reachable without a session, but only from our own origin. */
const ANONYMOUS_POSTS = ["/api/auth/login/options", "/api/auth/login/verify", "/api/auth/enrol/options", "/api/auth/enrol/verify"];

let w: World;
let c: Cast;
let server: ChildProcess;
let serverLog = "";
const tokens = new Map<Who, string | null>();

/** A correctly signed investor session cookie from the website, as an attacker would replay it. */
function investorCookie(): string {
  const id = randomUUID();
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const sig = createHmac("sha256", "any-website-secret").update(`session:${id}.${String(exp)}`).digest("base64url");
  return `${id}.${String(exp)}.${sig}`;
}

function cookieFor(who: Who): string | undefined {
  if (who === "anonymous") return undefined;
  if (who === "investor") {
    const v = investorCookie();
    return `pt_session=${v}; ${COOKIE}=${v}`;
  }
  return `${COOKIE}=${tokens.get(who) ?? ""}`;
}

async function req(
  path: string,
  opts: {
    method?: string;
    who?: Who;
    origin?: string | null;
    csrf?: string | null;
    form?: Record<string, string>;
    json?: boolean;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const who = opts.who ?? "anonymous";
  const headers = new Headers(opts.headers);
  const cookie = cookieFor(who);
  if (cookie) headers.set("cookie", cookie);
  const method = opts.method ?? "GET";
  let body: URLSearchParams | string | undefined;
  if (method === "POST") {
    if (opts.origin !== null) headers.set("origin", opts.origin ?? ORIGIN);
    const t = who === "anonymous" || who === "investor" ? null : tokens.get(who);
    const csrf = opts.csrf === undefined ? (t ? csrfFor(t) : undefined) : opts.csrf;
    if (opts.json) {
      headers.set("content-type", "application/json");
      if (csrf) headers.set("x-csrf-token", csrf);
      body = "{}";
    } else {
      body = new URLSearchParams({ ...(csrf ? { csrf } : {}), ...(opts.form ?? {}) });
    }
  }
  return fetch(`${ORIGIN}${resolve(path)}`, { method, headers, body, redirect: "manual" });
}

/** Items created in beforeAll, by placeholder name. */
const ids = new Map<string, string>();
function resolve(path: string): string {
  return path.replace(/\{(\w+)\}/g, (_m, k: string) => ids.get(k) ?? "missing");
}

let signer: TestSigner;
const SIGNER_PORT = 4998;
let compliance2: Actor;

beforeAll(async () => {
  w = await createWorld("pt_admin_testhttp");
  c = await cast(w);
  for (const [r, actor] of Object.entries(c)) tokens.set(r as Who, actor.token);
  // Step 6b items: a signing request through a real signing service, a payout batch, an unfreeze request.
  signer = await startTestSigner(w.name, SIGNER_PORT);
  ids.set("signer", await pendingMint(signer));
  ids.set("payout", await payoutBatch(w.su));
  ids.set("freeze", await freezePayouts(w.su));
  const unfreeze = await w.su.query<{ id: string }>("SELECT recon.request_unfreeze('operator:night-shift', 'cash difference explained by a late bank file') AS id");
  ids.set("unfreeze", unfreeze.rows[0]?.id ?? "");
  // Step 6c items: a KYC case opened by a possible match, a freeze request and an STR case (command-line names).
  const inReview = await investor(w.su, { screening: "review" });
  ids.set("kycCase", await caseOf(w.su, inReview.subjectId));
  await freezePolicies(w.su);
  const held = await investor(w.su);
  ids.set("heldWallet", held.wallet);
  ids.set("heldSubject", held.subjectId);
  const fr = await w.su.query<{ id: string }>("SELECT compliance.request_freeze('freeze', $1, 'court_order', 'court order received by the operator', 'operator:night', NULL, NULL) AS id", [held.wallet]);
  ids.set("freeze", fr.rows[0]?.id ?? "");
  const st = await w.su.query<{ id: string }>("SELECT compliance.open_str(NULL, 'unusual_pattern', 'Pattern of deposits inconsistent with the declared income', 'operator:night') AS id");
  ids.set("str", st.rows[0]?.id ?? "");
  compliance2 = await invite(w, c.admin, c.admin2, "http.compliance.two", "compliance_officer");
  // S-03 items: a calculated distribution, a proposed charge, a proposed rate and a requested export (command-line names).
  const ops = await operationsWorld(w.su, [{ wallet: held.wallet, units: 10n }]);
  ids.set("charge", ops.chargeId);
  ids.set("distribution", ops.distributionId);
  ids.set("taxRate", ops.rateId);
  ids.set("taxExport", ops.exportId);
  const dist = process.env.ADMIN_HTTP_DIST === ".next-http" ? ".next-http" : ".next";
  server = spawn(process.execPath, [join("node_modules", "next", "dist", "bin", "next"), "start", "--hostname", "127.0.0.1", "--port", String(PORT)], {
    cwd: join(__dirname, "..", ".."),
    env: {
      ...process.env,
      NODE_ENV: "production",
      NEXT_DIST_DIR: dist,
      ADMIN_ORIGIN: ORIGIN,
      ADMIN_PG_DATABASE: w.name,
      ADMIN_PG_USER: w.portalUser,
      ADMIN_PG_PASSWORD: w.portalPassword,
      // Unreachable on purpose: pages must still render (chain shown as down).
      CHAIN_RPC_URL: "http://127.0.0.1:9",
      SIGNER_URL: signer.url,
      SIGNER_CLIENT_SECRET_ADMIN: signer.adminSecret,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (d: Buffer) => (serverLog += d.toString()));
  server.stderr?.on("data", (d: Buffer) => (serverLog += d.toString()));
  for (let i = 0; i < 120; i++) {
    const ok = await fetch(`${ORIGIN}/api/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`portal did not start:\n${serverLog}`);
});

afterAll(async () => {
  server.kill();
  signer.stop();
  await w.drop();
});

describe("route coverage", () => {
  it("every registered route is exercised by this matrix", () => {
    const covered = new Set([
      ...PAGES.map((p) =>
        p.path
          .replace(/^\/audit\/(signer|recon|ledger|admin|compliance)$/, "/audit/[source]")
          .replace(/^\/approvals\/(signer|payouts|unfreeze|property)\/(\{\w+\}|\d+)$/, "/approvals/$1/[id]")
          .replace(/^\/compliance\/(kyc|freezes|str)\/(\{\w+\}|\d+)$/, "/compliance/$1/[id]")
          .replace(/^\/operations\/(charges|distributions)\/(\{\w+\}|\d+)$/, "/operations/$1/[id]")
          .replace(/^\/tax\/exports\/(\{\w+\}|\d+)$/, "/tax/exports/[id]"),
      ),
      ...APIS.map((a) =>
        a.path
          .replace(/^\/api\/audit\/\w+\/export$/, "/api/audit/[source]/export")
          .replace(/\/changes\/1\/decide$/, "/changes/[id]/decide")
          .replace(/^\/api\/approvals\/(signer|payouts|unfreeze|property)\/(\{\w+\}|\d+)\/decide$/, "/api/approvals/$1/[id]/decide")
          .replace(/^\/api\/compliance\/(kyc|freezes|str)\/\{\w+\}\/(act|decide|notes|export)$/, "/api/compliance/$1/[id]/$2")
          .replace(/^\/api\/operations\/(charges|distributions)\/\{\w+\}\/decide$/, "/api/operations/$1/[id]/decide")
          .replace(/^\/api\/tax\/(rates|exports)\/\{\w+\}\/(decide|generate)$/, "/api/tax/$1/[id]/$2"),
      ),
      ...ANONYMOUS_POSTS,
      "/login",
      "/enrol",
      "/api/health",
      "/api/auth/logout",
    ]);
    expect([...covered].sort()).toEqual(ROUTES.map((r) => r.path).sort());
  });
});

describe("pages × roles", () => {
  for (const page of PAGES) {
    for (const who of EVERYONE) {
      const allowed = (page.allowed as Who[]).includes(who);
      const expected = who === "anonymous" || who === "investor" ? 307 : allowed ? (page.okStatus ?? 200) : 403;
      it(`GET ${page.path} as ${who} -> ${String(expected)}`, async () => {
        const res = await req(page.path, { who });
        expect(res.status, serverLog.slice(-2000)).toBe(expected);
        if (expected === 307 && (who === "anonymous" || who === "investor")) {
          expect(res.headers.get("location")).toMatch(/^\/login\?next=/);
        }
      });
    }
  }

  it("the sign-in page sends signed-in officers to their landing page", async () => {
    expect((await req("/login")).status).toBe(200);
    const admin = await req("/login", { who: "admin" });
    expect(admin.status).toBe(307);
    expect(admin.headers.get("location")).toBe("/officers");
    expect((await req("/login", { who: "trustee_officer" })).headers.get("location")).toBe("/trustee");
    expect((await req("/login", { who: "tax_officer" })).headers.get("location")).toBe("/tax");
    expect((await req("/enrol")).status).toBe(200);
    expect((await req("/api/health")).status).toBe(200);
  });

  it("a denied page view is in the audit log as access.denied", async () => {
    const before = (await w.su.query<{ m: string }>("SELECT coalesce(max(id), 0) AS m FROM admin.audit")).rows[0]?.m;
    await req("/officers", { who: "ops_maker" });
    const { rows } = await w.su.query<{ action: string; actor: string; detail: { resource: string } }>(
      "SELECT action, actor, detail FROM admin.audit WHERE id > $1 ORDER BY id",
      [before],
    );
    expect(rows.map((r) => r.action)).toContain("access.denied");
    expect(rows.find((r) => r.action === "access.denied")?.detail.resource).toBe("/officers");
  });
});

describe("API routes × roles", () => {
  for (const api of APIS) {
    for (const who of EVERYONE) {
      const allowed = (api.allowed as Who[]).includes(who);
      const expected = who === "anonymous" || who === "investor" ? 401 : allowed ? api.okStatus : 403;
      it(`POST ${api.path} as ${who} -> ${String(expected)}`, async () => {
        const res = await req(api.path, { method: "POST", who, form: api.form, json: api.json });
        expect(res.status, serverLog.slice(-2000)).toBe(expected);
      });
    }
  }

  for (const path of ANONYMOUS_POSTS) {
    it(`POST ${path} works without a session from our origin, and never from another`, async () => {
      const res = await req(path, { method: "POST", json: true });
      expect([200, 400], serverLog.slice(-3000)).toContain(res.status);
      expect((await req(path, { method: "POST", origin: "https://evil.example" })).status).toBe(403);
      expect((await req(path, { method: "POST", origin: null })).status).toBe(403);
    });
  }

  it("GET on a POST-only route is refused", async () => {
    expect((await req("/api/officers/changes", { who: "admin" })).status).toBe(405);
  });
});

describe("CSRF and same-origin on every mutating route", () => {
  const mutating = [...APIS.map((a) => ({ path: a.path, json: a.json })), { path: "/api/auth/logout", json: undefined }];
  for (const { path, json } of mutating) {
    it(`${path}: refused without origin, from another origin, cross-site fetch, without or with a wrong CSRF token`, async () => {
      const who = userOf(path);
      expect((await req(path, { method: "POST", who, json, origin: null })).status).toBe(403);
      expect((await req(path, { method: "POST", who, json, origin: "null" })).status).toBe(403);
      expect((await req(path, { method: "POST", who, json, origin: "null", headers: { "sec-fetch-site": "same-site" } })).status).toBe(403);
      expect((await req(path, { method: "POST", who, json, origin: "https://evil.example" })).status).toBe(403);
      expect((await req(path, { method: "POST", who, json, headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
      expect((await req(path, { method: "POST", who, json, csrf: null })).status).toBe(403);
      expect((await req(path, { method: "POST", who, json, csrf: "x".repeat(43) })).status).toBe(403);
      // The CSRF token of another officer's session does not work either.
      expect((await req(path, { method: "POST", who, json, csrf: csrfFor(tokens.get("trustee_officer") ?? "") })).status).toBe(403);
    });
  }
});

describe("form posts from the portal itself", () => {
  it('accept "Origin: null" (no-referrer policy) only with Sec-Fetch-Site: same-origin', async () => {
    const ok = await req("/api/officers/changes", {
      method: "POST",
      who: "admin",
      origin: "null",
      headers: { "sec-fetch-site": "same-origin" },
      form: { kind: "invite", reason: "short" },
    });
    expect(ok.status).toBe(303);
  });
});

describe("evidence export", () => {
  it("returns a ZIP whose manifest matches the data file and the audit entry recorded before release", async () => {
    const res = await req("/api/audit/admin/export", { method: "POST", who: "auditor", form: { format: "csv", action: "login" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const files = unzipStore(new Uint8Array(await res.arrayBuffer()));
    const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json"))) as {
      files: { name: string; sha256: string }[];
      rows: number;
      exportAuditEntry: { id: string; hash: string };
      chainVerification: { problems: number };
    };
    const data = files.get(manifest.files[0]?.name ?? "") ?? new Uint8Array();
    expect(sha256Hex(data)).toBe(manifest.files[0]?.sha256);
    expect(manifest.rows).toBeGreaterThan(0);
    expect(manifest.chainVerification.problems).toBe(0);
    const { rows } = await w.su.query<{ action: string; detail: { sha256: string }; hash: Buffer }>(
      "SELECT action, detail, hash FROM admin.audit WHERE id = $1",
      [manifest.exportAuditEntry.id],
    );
    expect(rows[0]?.action).toBe("audit.exported");
    expect(rows[0]?.detail.sha256).toBe(manifest.files[0]?.sha256);
    expect(rows[0]?.hash.toString("hex")).toBe(manifest.exportAuditEntry.hash);
    const sums = new TextDecoder().decode(files.get("SHA256SUMS"));
    expect(sums).toContain(createHash("sha256").update(files.get("manifest.json") ?? new Uint8Array()).digest("hex"));
  });
});

describe("approvals over HTTP (Step 6b)", () => {
  let counter = Date.now();
  // eslint-disable-next-line security/detect-non-literal-regexp -- test ids are fixed literals of this file
  const testId = (html: string, id: string): string => new RegExp(`data-testid="${id}"[^>]*>([^<]+)<`).exec(html)?.[1] ?? "";
  const location = (res: Response): string => decodeURIComponent(res.headers.get("location") ?? "");
  async function stepUp(who: Role, stale = false): Promise<void> {
    // eslint-disable-next-line security/detect-object-injection
    const a = c[who];
    await w.portal.query("SELECT admin.record_step_up($1, $2, $3)", [a.sessionHash, a.credentialId, ++counter]);
    if (stale) {
      await w.su.query("ALTER TABLE admin.sessions DISABLE TRIGGER sessions_guard");
      await w.su.query("UPDATE admin.sessions SET step_up_at = step_up_at - interval '5 minutes 1 second' WHERE token_hash = $1", [a.sessionHash]);
      await w.su.query("ALTER TABLE admin.sessions ENABLE TRIGGER sessions_guard");
    }
  }

  it("a checker approves a signing request as shown; the signing service decides; stale step-up and a second approval are refused", async () => {
    const id = await pendingMint(signer);
    const page = await req(`/approvals/signer/${id}`, { who: "ops_checker" });
    expect(page.status, serverLog.slice(-2000)).toBe(200);
    const html = await page.text();
    expect(html).toContain("mint(address, uint256, bytes32)");
    const payloadHash = testId(html, "payload-hash");
    const callHash = testId(html, "call-hash");
    expect(payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(callHash).toMatch(/^[0-9a-f]{64}$/);
    const decide = (who: Role) =>
      req(`/api/approvals/signer/${id}/decide`, { method: "POST", who, form: { decision: "approve", reason: "checked against the subscription", payloadHash, callHash } });

    await stepUp("ops_checker", true);
    const stale = await decide("ops_checker");
    expect(stale.status).toBe(303);
    expect(location(stale)).toMatch(/error=Confirm with your security key first/);
    expect((await w.su.query("SELECT 1 FROM signer.approvals WHERE request_id = $1", [id])).rowCount).toBe(0);

    await stepUp("ops_checker");
    const ok = await decide("ops_checker");
    expect(location(ok), serverLog.slice(-2000)).toMatch(/ok=Decision recorded by the signing service: request is now pending_approval/);
    const approvals = await w.su.query<{ operator: string }>("SELECT operator FROM signer.approvals WHERE request_id = $1", [id]);
    expect(approvals.rows.map((r) => r.operator)).toEqual([c.ops_checker.handle]);
    // The same checker again: refused before anything reaches the signing service.
    expect(location(await decide("ops_checker"))).toMatch(/error=You already decided/);
    // What the page now explains.
    const after = await (await req(`/approvals/signer/${id}`, { who: "ops_checker" })).text();
    expect(after).toContain("decision-unavailable");
    // A changed call (as if the policy had changed since the page was shown) is refused by the signing service.
    const other = await pendingMint(signer);
    const otherHtml = await (await req(`/approvals/signer/${other}`, { who: "ops_checker" })).text();
    const wrong = await req(`/api/approvals/signer/${other}/decide`, {
      method: "POST",
      who: "ops_checker",
      form: { decision: "approve", reason: "checked against the subscription", payloadHash: testId(otherHtml, "payload-hash"), callHash: "ab".repeat(32) },
    });
    expect(location(wrong)).toMatch(/error=Refused by the signing service: the transaction changed since you reviewed it/);
  });

  it("a payout batch cannot be approved while reconciliation has payouts frozen", async () => {
    const html = await (await req(`/approvals/payouts/${resolve("{payout}")}`, { who: "ops_checker" })).text();
    expect(html).toContain("approve-unavailable");
    expect(html).not.toMatch(/PK\d{2}[A-Z]{4}/); // no IBAN, only the last four digits
    await stepUp("ops_checker");
    const res = await req(`/api/approvals/payouts/${resolve("{payout}")}/decide`, {
      method: "POST",
      who: "ops_checker",
      form: { decision: "approve", reason: "totals match the finalized distribution", itemsDigest: testId(html, "items-digest") },
    });
    expect(location(res)).toMatch(/error=payouts are blocked by reconciliation/);
    expect((await w.su.query<{ status: string }>("SELECT status FROM bank.payout_batches WHERE id = $1", [resolve("{payout}")])).rows[0]?.status).toBe("created");
  });

  it("a maker asks for an unfreeze, a checker approves it once a run passed; the gate opens", async () => {
    // The open request from beforeAll blocks a second one for the same freeze: freeze again first.
    const event = await freezePayouts(w.su);
    const asked = await req("/api/approvals/unfreeze", { method: "POST", who: "ops_maker", form: { reason: "difference explained by a late bank file" } });
    expect(asked.status).toBe(303);
    const id = /\/approvals\/unfreeze\/(\d+)\?ok=/.exec(location(asked))?.[1] ?? "";
    expect(id).not.toBe("");
    const decide = () =>
      req(`/api/approvals/unfreeze/${id}/decide`, { method: "POST", who: "ops_checker", form: { decision: "approve", reason: "late bank file imported, difference gone", freezeEvent: event } });
    await stepUp("ops_checker");
    expect(location(await decide())).toMatch(/error=unfreezing needs a reconciliation run that passed/);
    await passRecon(w.su);
    expect(location(await decide())).toMatch(/ok=Decision recorded: approved/);
    const gate = await w.su.query<{ allowed: boolean }>("SELECT allowed FROM recon.payout_gate()");
    expect(gate.rows[0]?.allowed).toBe(true);
    const decided = await w.su.query<{ requested_by: string; decided_by: string }>("SELECT requested_by, decided_by FROM recon.unfreeze_requests WHERE id = $1", [id]);
    expect(decided.rows[0]).toEqual({ requested_by: c.ops_maker.handle, decided_by: c.ops_checker.handle });
  });

  it("every view of a pending item and every decision is in the admin audit chain, which stays intact", async () => {
    const { rows } = await w.su.query<{ action: string; detail: { resource?: string; kind?: string } }>(
      "SELECT action, detail FROM admin.audit WHERE action IN ('page.view', 'approval.ticket', 'approval.decided', 'approval.refused', 'approval.requested') ORDER BY id",
    );
    const views = rows.filter((r) => r.action === "page.view").map((r) => r.detail.resource ?? "");
    expect(views).toEqual(expect.arrayContaining([`/approvals/signer/${resolve("{signer}")}`, `/approvals/payouts/${resolve("{payout}")}`, "/approvals"]));
    expect(rows.map((r) => `${r.action}:${r.detail.kind ?? ""}`)).toEqual(
      expect.arrayContaining(["approval.ticket:signer", "approval.decided:signer", "approval.refused:payout", "approval.requested:unfreeze", "approval.decided:unfreeze"]),
    );
    expect((await w.su.query("SELECT * FROM admin.verify_audit()")).rows).toEqual([]);
  });
});

describe("compliance over HTTP (Step 6c)", () => {
  let counter = Date.now() + 1_000_000;
  const location = (res: Response): string => decodeURIComponent(res.headers.get("location") ?? "");
  const digestOf = (html: string): string => /name="digest" value="([0-9a-f]{64})"/.exec(html)?.[1] ?? "";
  async function fresh(a: Actor, stale = false): Promise<void> {
    await w.portal.query("SELECT admin.record_step_up($1, $2, $3)", [a.sessionHash, a.credentialId, ++counter]);
    if (stale) {
      await w.su.query("ALTER TABLE admin.sessions DISABLE TRIGGER sessions_guard");
      await w.su.query("UPDATE admin.sessions SET step_up_at = step_up_at - interval '5 minutes 1 second' WHERE token_hash = $1", [a.sessionHash]);
      await w.su.query("ALTER TABLE admin.sessions ENABLE TRIGGER sessions_guard");
    }
  }
  /** Runs fn as the second compliance officer (the matrix's own compliance officer is restored afterwards). */
  async function asSecond<T>(fn: () => Promise<T>): Promise<T> {
    tokens.set("compliance_officer", compliance2.token);
    try {
      return await fn();
    } finally {
      tokens.set("compliance_officer", c.compliance_officer.token);
    }
  }

  it("pages show masked identifiers only (no CNIC, IBAN or name)", async () => {
    for (const p of ["/compliance", "/compliance/kyc", `/compliance/kyc/${resolve("{kycCase}")}`, "/compliance/screening", `/compliance/freezes/${resolve("{freeze}")}`, `/compliance/str/${resolve("{str}")}`]) {
      const html = await (await req(p, { who: "compliance_officer" })).text();
      expect(html, p).not.toMatch(/\d{5}-\d{7}-\d|\d{13}|PK\d{2}[A-Z]{4}/);
    }
    expect(await (await req(`/compliance/kyc/${resolve("{kycCase}")}`, { who: "compliance_officer" })).text()).toMatch(/\*{5}-\*{4}\d{3}-\d/);
  });

  it("a high-risk KYC case needs two compliance officers; a stale step-up is refused", async () => {
    const path = `/compliance/kyc/${resolve("{kycCase}")}`;
    const act = async (decision: string) => {
      const digest = digestOf(await (await req(path, { who: "compliance_officer" })).text());
      return location(await req(`/api/compliance/kyc/${resolve("{kycCase}")}/act`, { method: "POST", who: "compliance_officer", form: { decision, reason: "screening evidence reviewed in full", digest } }));
    };
    await fresh(c.compliance_officer, true);
    expect(await act("approve")).toMatch(/error=Confirm with your security key first/);
    await fresh(c.compliance_officer);
    expect(await act("approve")).toMatch(/ok=Recorded: the case is now pending_second/);
    // The proposer gets no decision form, only the reason (the database refuses it too: see test/db/compliance.test.ts).
    const mine = await (await req(path, { who: "compliance_officer" })).text();
    expect(digestOf(mine)).toBe("");
    expect(mine).toContain("You proposed it");
    await fresh(compliance2);
    expect(await asSecond(() => act("confirm"))).toMatch(/ok=Recorded: the case is now approved/);
  });

  it("a freeze proposed by one officer is approved by another and queued for the signing service", async () => {
    const path = `/compliance/freezes/${resolve("{freeze}")}`;
    await fresh(c.compliance_officer);
    const digest = digestOf(await (await req(path, { who: "compliance_officer" })).text());
    const res = await req(`${path.replace("/compliance/", "/api/compliance/")}/decide`, {
      method: "POST",
      who: "compliance_officer",
      form: { decision: "approve", reason: "court order verified with the registry", digest },
    });
    expect(location(res)).toMatch(/ok=Approved: the command is in the outbox/);
    const cmd = await w.su.query<{ kind: string }>("SELECT kind FROM outbox.commands WHERE idempotency_key = $1", [`compliance.freeze:request:${resolve("{freeze}")}`]);
    expect(cmd.rows[0]?.kind).toBe("compliance.freeze");
    const st = await w.su.query<{ s: string }>("SELECT kyc.subject_status($1) AS s", [ids.get("heldSubject")]);
    expect(st.rows[0]?.s).toBe("suspended");
    // Proposing through the portal: the maker cannot decide their own unfreeze.
    const asked = await req("/api/compliance/freezes", {
      method: "POST",
      who: "compliance_officer",
      form: { kind: "unfreeze", wallet: ids.get("heldWallet") ?? "", reasonCode: "court_release", reason: "the court lifted the order today" },
    });
    const uid = /\/compliance\/freezes\/(\d+)\?ok=/.exec(location(asked))?.[1] ?? "";
    expect(uid, location(asked)).not.toBe("");
    const udigest = digestOf(await (await req(`/compliance/freezes/${uid}`, { who: "compliance_officer" })).text());
    expect(udigest).toBe(""); // the proposer sees no decision form, only the reason why
  });

  it("an STR export is recorded before it is handed out, and its file matches the record", async () => {
    await fresh(c.compliance_officer);
    const res = await req(`/api/compliance/str/${resolve("{str}")}/export`, { method: "POST", who: "compliance_officer", form: { decision: "export" } });
    expect(res.status, serverLog.slice(-2000)).toBe(200);
    const files = unzipStore(new Uint8Array(await res.arrayBuffer()));
    const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json"))) as { files: { name: string; sha256: string }[] };
    const data = files.get(manifest.files[0]?.name ?? "") ?? new Uint8Array();
    expect(sha256Hex(data)).toBe(manifest.files[0]?.sha256);
    expect(new TextDecoder().decode(data)).not.toMatch(/\d{13}|name_enc/);
    const rec = await w.su.query<{ sha256: Buffer }>("SELECT sha256 FROM compliance.str_exports WHERE case_id = $1", [resolve("{str}")]);
    expect(rec.rows.map((r) => r.sha256.toString("hex"))).toContain(manifest.files[0]?.sha256);
    expect((await w.su.query("SELECT * FROM compliance.verify_audit()")).rows).toEqual([]);
    expect((await w.su.query("SELECT * FROM admin.verify_audit()")).rows).toEqual([]);
  });
});

describe("operations and tax over HTTP (S-03)", () => {
  const location = (res: Response): string => decodeURIComponent(res.headers.get("location") ?? "");
  const digestOf = (html: string): string => /name="digest" value="([0-9a-f]{64})"/.exec(html)?.[1] ?? "";
  let counter = Date.now() + 2_000_000;

  it("a checker approves a charge as shown (step-up, digest); the journal is posted under the checker's handle", async () => {
    const path = `/operations/charges/${resolve("{charge}")}`;
    const html = await (await req(path, { who: "ops_checker" })).text();
    expect(html).toContain("lift repair, tower B");
    await w.portal.query("SELECT admin.record_step_up($1, $2, $3)", [c.ops_checker.sessionHash, c.ops_checker.credentialId, ++counter]);
    const res = await req(`/api${path}/decide`, { method: "POST", who: "ops_checker", form: { decision: "approve", reason: "invoice checked against the budget", digest: digestOf(html) } });
    expect(location(res), serverLog.slice(-2000)).toMatch(/ok=Approved: the journal is posted/);
    const j = await w.su.query<{ created_by: string }>("SELECT created_by FROM ledger.journal WHERE idempotency_key LIKE $1", [`expense:%:${resolve("{charge}")}:approved`]);
    expect(j.rows[0]?.created_by).toBe(c.ops_checker.handle);
  });

  it("tax pages show placeholder rates and never a CNIC; without the tax service client no file can be generated", async () => {
    const tax = await (await req("/tax", { who: "tax_officer" })).text();
    expect(tax).toContain("placeholder-banner");
    const exp = await (await req(`/tax/exports/${resolve("{taxExport}")}`, { who: "tax_officer" })).text();
    expect(exp).toContain("generate-unavailable");
    for (const p of [tax, exp, await (await req(`/operations/distributions/${resolve("{distribution}")}`, { who: "auditor" })).text()]) {
      expect(p).not.toMatch(/\d{5}-\d{7}-\d|\d{13}/);
    }
  });
});

describe("session limits over HTTP", () => {
  it("an idle session (15 min) is ended and the officer is sent to sign in again", async () => {
    const o = await invite(w, c.admin, c.admin2, "http.idle", "auditor");
    tokens.set("auditor", o.token);
    expect((await req("/account", { who: "auditor" })).status).toBe(200);
    await w.su.query("ALTER TABLE admin.sessions DISABLE TRIGGER sessions_guard");
    await w.su.query("UPDATE admin.sessions SET last_seen_at = now() - interval '15 minutes 1 second' WHERE token_hash = $1", [o.sessionHash]);
    await w.su.query("ALTER TABLE admin.sessions ENABLE TRIGGER sessions_guard");
    const res = await req("/account", { who: "auditor" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toMatch(/expired=1/);
    expect((await req("/api/auth/stepup/options", { method: "POST", who: "auditor" })).status).toBe(401);
    tokens.set("auditor", c.auditor.token);
  });

  it("a session past 8 hours is ended even if active", async () => {
    const o = await invite(w, c.admin, c.admin2, "http.long", "ops_maker");
    tokens.set("ops_maker", o.token);
    await w.su.query("ALTER TABLE admin.sessions DISABLE TRIGGER sessions_guard");
    await w.su.query(
      "UPDATE admin.sessions SET created_at = now() - interval '8 hours 1 second', expires_at = now() - interval '1 second', last_seen_at = now() WHERE token_hash = $1",
      [o.sessionHash],
    );
    await w.su.query("ALTER TABLE admin.sessions ENABLE TRIGGER sessions_guard");
    expect((await req("/", { who: "ops_maker" })).status).toBe(307);
    tokens.set("ops_maker", c.ops_maker.token);
  });
});

describe("headers and host", () => {
  it("sends a nonce CSP without unsafe-inline scripts, no-store and anti-framing headers", async () => {
    const res = await req("/login");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'(;|$)/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  it("refuses unknown Host headers (DNS rebinding), including 127.0.0.1 (WebAuthn needs the localhost origin)", async () => {
    // fetch() cannot set Host; a raw request can (as a DNS-rebinding page would make the browser do).
    const evil = await new Promise<number>((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port: PORT, path: "/login", headers: { host: `evil.example:${String(PORT)}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      r.on("error", reject);
      r.end();
    });
    expect(evil).toBe(421);
    const ip = await fetch(`http://127.0.0.1:${String(PORT)}/login`, { redirect: "manual" });
    expect(ip.status).toBe(421);
    expect(await ip.text()).toContain(ORIGIN);
  });

  it("the session cookie is set only by a verified sign-in (never by a page)", async () => {
    for (const p of ["/login", "/enrol", "/api/health"]) expect((await req(p)).headers.get("set-cookie")).toBeNull();
  });
});

// Last: signing out ends each session.
describe("logout", () => {
  for (const who of ROLES) {
    it(`${who} signs out; the session no longer works`, async () => {
      const res = await req("/api/auth/logout", { method: "POST", who });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`${ORIGIN}/login?bye=1`);
      expect(res.headers.get("set-cookie") ?? "").toMatch(/__Host-pt_admin=;.*Max-Age=0/i);
      expect((await req("/account", { who })).status).toBe(307);
    });
  }
  it("anonymous logout is refused", async () => {
    expect((await req("/api/auth/logout", { method: "POST" })).status).toBe(401);
  });
});
