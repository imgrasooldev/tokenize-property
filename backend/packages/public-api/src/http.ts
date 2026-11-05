import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readBody } from "@pt/http-auth";
import { z } from "zod";
import { AuthService, CatalogueService, InvestorService, OAuthError, RequestError } from "./services.ts";

/**
 * HTTP layer (controllers) of the public API, ADR 0018: parses and validates requests, calls one
 * service, and answers per the contract docs/api/openapi.json: RFC 9457 problems, RFC 6749 OAuth
 * errors, RFC 6750 bearer tokens, ETag (RFC 9110), Link (RFC 8288), RateLimit headers (IETF
 * draft), X-Request-Id. No CORS: native clients only. Bound to 127.0.0.1 behind nginx.
 */

export interface ApiDeps {
  auth: AuthService;
  catalogue: CatalogueService;
  investors: InvestorService;
  /** The OpenAPI document served at /v1/openapi.json. */
  openapi: unknown;
  /** Requests per minute per client key (bearer token or address). */
  ratePerMinute?: number;
  now?: () => number;
}

const MAX_BODY = 4 * 1024;
const LIMIT = z.coerce.number().int().min(1).max(100).default(20);
const CURSOR = z.string().max(200).nullable();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,64}$/;
const CHANGE = z.strictObject({ action: z.enum(["cancel", "withdraw"]) });
const RESERVE = z.strictObject({ offering_id: z.string().regex(UUID), units: z.string().regex(/^[1-9][0-9]{0,12}$/) });

class Problem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly detail?: string,
  ) {
    super(title);
  }
}

type Handler = (req: IncomingMessage, url: URL, params: string[]) => Promise<Answer>;
interface Answer {
  status: number;
  body?: unknown;
  cache: "no-store" | "private, no-store" | "public, max-age=30";
  link?: string | undefined;
  etag?: boolean;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string>, contentType = "application/json"): void {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    ...headers,
    ...(body === undefined ? {} : { "Content-Type": `${contentType}; charset=utf-8`, "Content-Length": String(Buffer.byteLength(text)) }),
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

function locale(req: IncomingMessage): "en" | "ur" {
  return /^\s*ur\b/i.test(req.headers["accept-language"] ?? "") ? "ur" : "en";
}

function bearer(req: IncomingMessage): string | null {
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? "");
  return m?.[1] ?? null;
}

async function form(req: IncomingMessage): Promise<URLSearchParams> {
  if (!(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) throw new OAuthError("invalid_request", "use application/x-www-form-urlencoded");
  const body = await readBody(req, MAX_BODY);
  if (body === null) throw new OAuthError("invalid_request", "body too large");
  const p = new URLSearchParams(body);
  // RFC 6749 section 3.2: parameters must not be repeated.
  for (const k of new Set(p.keys())) if (p.getAll(k).length > 1) throw new OAuthError("invalid_request", `repeated parameter ${k}`);
  return p;
}

/** A small JSON body (phase 2a writes). */
async function json(req: IncomingMessage): Promise<unknown> {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new Problem(415, "unsupported_media_type", "Send application/json");
  const body = await readBody(req, MAX_BODY);
  if (body === null) throw new Problem(413, "body_too_large", "Body too large");
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Problem(400, "invalid_body", "The body is not valid JSON");
  }
}

function pageParams(url: URL): { cursor: string | null; limit: number } {
  const limit = LIMIT.safeParse(url.searchParams.get("limit") ?? undefined);
  const cursor = CURSOR.safeParse(url.searchParams.get("cursor"));
  if (!limit.success || !cursor.success) throw new Problem(400, "invalid_query", "Invalid query parameters", "limit is 1-100; cursor is the next_cursor of the previous page");
  return { cursor: cursor.data, limit: limit.data };
}

function nextLink(url: URL, next: string | null): string | undefined {
  if (!next) return undefined;
  const u = new URL(url.toString());
  u.searchParams.set("cursor", next);
  return `<${u.pathname}${u.search}>; rel="next"`;
}

export function createApiServer(deps: ApiDeps): Server {
  const now = deps.now ?? Date.now;
  const perMinute = deps.ratePerMinute ?? 120;
  const buckets = new Map<string, { start: number; used: number }>();

  const signedIn = async (req: IncomingMessage): Promise<Buffer> => {
    const t = bearer(req);
    const h = t ? await deps.investors.authenticate(t) : null;
    if (!h) throw new Problem(401, "invalid_token", "Sign in again", "the access token is missing, expired or revoked");
    return h;
  };

  const routes: [string, RegExp, Handler][] = [
    ["GET", /^\/v1\/openapi\.json$/, () => Promise.resolve({ status: 200, body: deps.openapi, cache: "public, max-age=30", etag: true })],
    [
      "POST",
      /^\/v1\/oauth\/device_authorization$/,
      async (req) => {
        const p = await form(req);
        const body = await deps.auth.deviceAuthorization({ clientId: p.get("client_id") ?? "", scope: p.get("scope") ?? undefined, deviceName: p.get("device_name") ?? undefined });
        return { status: 200, body, cache: "no-store" };
      },
    ],
    [
      "POST",
      /^\/v1\/oauth\/token$/,
      async (req) => {
        const p = await form(req);
        const body = await deps.auth.token({
          grantType: p.get("grant_type") ?? "",
          clientId: p.get("client_id") ?? "",
          deviceCode: p.get("device_code") ?? undefined,
          refreshToken: p.get("refresh_token") ?? undefined,
        });
        return { status: 200, body, cache: "no-store" };
      },
    ],
    [
      "POST",
      /^\/v1\/oauth\/revoke$/,
      async (req) => {
        const p = await form(req);
        const t = p.get("token") ?? "";
        if (!TOKEN.test(t)) return { status: 200, cache: "no-store" }; // RFC 7009 section 2.2: unknown tokens are not an error
        await deps.auth.revoke({ clientId: p.get("client_id") ?? "", token: t });
        return { status: 200, cache: "no-store" };
      },
    ],
    [
      "GET",
      /^\/v1\/offerings$/,
      async (_req, url) => {
        const { cursor, limit } = pageParams(url);
        const body = await deps.catalogue.offerings(cursor, limit);
        return { status: 200, body, cache: "public, max-age=30", etag: true, link: nextLink(url, body.next_cursor) };
      },
    ],
    [
      "GET",
      /^\/v1\/offerings\/([^/]+)$/,
      async (_req, _url, [id = ""]) => {
        if (!UUID.test(id)) throw new Problem(404, "not_found", "No such offering");
        const body = await deps.catalogue.offering(id);
        if (!body) throw new Problem(404, "not_found", "No such offering");
        return { status: 200, body, cache: "public, max-age=30", etag: true };
      },
    ],
    ["GET", /^\/v1\/status$/, async () => ({ status: 200, body: await deps.catalogue.status(), cache: "public, max-age=30" })],
    [
      "GET",
      /^\/v1\/me$/,
      async (req) => {
        const body = await deps.investors.me(await signedIn(req));
        if (!body) throw new Problem(401, "invalid_token", "Sign in again");
        return { status: 200, body, cache: "private, no-store", etag: true };
      },
    ],
    [
      "GET",
      /^\/v1\/me\/holdings$/,
      async (req) => {
        const h = await signedIn(req);
        const status = await deps.catalogue.status();
        return { status: 200, body: await deps.investors.holdings(h, status.as_of_block), cache: "private, no-store" };
      },
    ],
    [
      "GET",
      /^\/v1\/me\/subscriptions$/,
      async (req, url) => {
        const h = await signedIn(req);
        const { cursor, limit } = pageParams(url);
        const body = await deps.investors.subscriptions(h, cursor, limit);
        return { status: 200, body, cache: "private, no-store", link: nextLink(url, body.next_cursor) };
      },
    ],
    [
      "GET",
      /^\/v1\/me\/distributions$/,
      async (req, url) => {
        const h = await signedIn(req);
        const { cursor, limit } = pageParams(url);
        const body = await deps.investors.distributions(h, cursor, limit);
        return { status: 200, body, cache: "private, no-store", link: nextLink(url, body.next_cursor) };
      },
    ],
    [
      "GET",
      /^\/v1\/me\/distributions\/(0x[0-9a-f]{40})\/([0-9]{1,30})\/proof$/,
      async (req, _url, [token = "", id = ""]) => {
        const body = await deps.investors.proof(await signedIn(req), token, id);
        if (!body) throw new Problem(404, "not_found", "No entitlement of yours in this distribution");
        return { status: 200, body, cache: "private, no-store" };
      },
    ],
    [
      "POST",
      /^\/v1\/me\/subscription-requests$/,
      async (req) => {
        const h = await signedIn(req);
        const key = req.headers["idempotency-key"];
        if (typeof key !== "string" || !IDEMPOTENCY_KEY.test(key)) {
          throw new Problem(400, "idempotency_key_required", "Idempotency-Key header required", "8-64 characters: letters, digits, . _ : -");
        }
        const body = RESERVE.safeParse(await json(req));
        if (!body.success) throw new Problem(400, "invalid_body", "Invalid request body", "offering_id (uuid) and units (whole number as a string) are required");
        try {
          const r = await deps.investors.requestReservation(h, { offeringId: body.data.offering_id, units: BigInt(body.data.units), idempotencyKey: key });
          return { status: r.created ? 201 : 200, body: r.body, cache: "no-store" };
        } catch (e) {
          if (!(e instanceof RequestError)) throw e;
          if (e.reason === "token") throw new Problem(401, "invalid_token", "Sign in again");
          if (e.reason === "conflict") throw new Problem(409, "idempotency_conflict", "This Idempotency-Key was used with another body");
          if (e.reason === "limit") throw new Problem(409, "too_many_pending", "Too many requests wait for confirmation", "confirm or let one expire first");
          throw new Problem(422, "offering_not_open", "The offering is not open for reservations");
        }
      },
    ],
    [
      "POST",
      /^\/v1\/me\/subscriptions\/([^/]+)\/change-requests$/,
      async (req, _url, [id = ""]) => {
        const h = await signedIn(req);
        const key = req.headers["idempotency-key"];
        if (typeof key !== "string" || !IDEMPOTENCY_KEY.test(key)) {
          throw new Problem(400, "idempotency_key_required", "Idempotency-Key header required", "8-64 characters: letters, digits, . _ : -");
        }
        const body = CHANGE.safeParse(await json(req));
        if (!body.success) throw new Problem(400, "invalid_body", "Invalid request body", 'action is "cancel" or "withdraw"');
        if (!UUID.test(id)) throw new Problem(404, "not_found", "No such subscription of yours");
        try {
          const r = await deps.investors.requestChange(h, { subscriptionId: id, action: body.data.action, idempotencyKey: key });
          return { status: r.created ? 201 : 200, body: r.body, cache: "no-store" };
        } catch (e) {
          if (!(e instanceof RequestError)) throw e;
          if (e.reason === "token") throw new Problem(401, "invalid_token", "Sign in again");
          if (e.reason === "unknown") throw new Problem(404, "not_found", "No such subscription of yours");
          if (e.reason === "conflict") throw new Problem(409, "idempotency_conflict", "This Idempotency-Key was used with another body");
          if (e.reason === "limit") throw new Problem(409, "too_many_pending", "Too many requests wait for confirmation", "confirm or let one expire first");
          throw new Problem(422, "not_allowed_now", `This subscription cannot be ${body.data.action === "cancel" ? "cancelled" : "withdrawn"} now`);
        }
      },
    ],
    [
      "GET",
      /^\/v1\/me\/subscription-requests\/([^/]+)$/,
      async (req, _url, [id = ""]) => {
        const h = await signedIn(req);
        const body = UUID.test(id) ? await deps.investors.requestStatus(h, id) : null;
        if (!body) throw new Problem(404, "not_found", "No such request of yours");
        return { status: 200, body, cache: "private, no-store" };
      },
    ],
    [
      "GET",
      /^\/v1\/me\/subscriptions\/([^/]+)$/,
      async (req, _url, [id = ""]) => {
        const h = await signedIn(req);
        const body = UUID.test(id) ? await deps.investors.subscription(h, id) : null;
        if (!body) throw new Problem(404, "not_found", "No such subscription of yours");
        return { status: 200, body, cache: "private, no-store" };
      },
    ],
    ["GET", /^\/v1\/me\/tax-certificates$/, async (req) => ({ status: 200, body: await deps.investors.certificates(await signedIn(req)), cache: "private, no-store" })],
    [
      "GET",
      /^\/v1\/me\/notifications$/,
      async (req, url) => {
        const h = await signedIn(req);
        const { cursor, limit } = pageParams(url);
        const body = await deps.investors.notifications(h, locale(req), cursor, limit);
        return { status: 200, body, cache: "private, no-store", link: nextLink(url, body.next_cursor) };
      },
    ],
  ];

  return createServer((req, res) => {
    void (async () => {
      const given = req.headers["x-request-id"];
      const requestId = typeof given === "string" && REQUEST_ID.test(given) ? given : randomUUID();
      const base: Record<string, string> = { "X-Request-Id": requestId };
      const url = new URL(req.url ?? "/", "http://internal");
      try {
        // Rate limit per bearer token, else per address (behind nginx: X-Real-IP set by the proxy only).
        const realIp = process.env.TRUST_PROXY === "1" ? req.headers["x-real-ip"] : undefined;
        const key = bearer(req) ?? (typeof realIp === "string" && realIp ? realIp : (req.socket.remoteAddress ?? "?"));
        const t = now();
        const b = buckets.get(key);
        const bucket = b && t - b.start < 60_000 ? b : { start: t, used: 0 };
        bucket.used++;
        buckets.set(key, bucket);
        if (buckets.size > 50_000) buckets.clear();
        const reset = Math.max(1, Math.ceil((bucket.start + 60_000 - t) / 1000));
        base["RateLimit-Policy"] = `"default";q=${String(perMinute)};w=60`;
        base.RateLimit = `"default";r=${String(Math.max(0, perMinute - bucket.used))};t=${String(reset)}`;
        if (bucket.used > perMinute) {
          send(res, 429, { type: "about:blank", title: "Too many requests", status: 429, code: "rate_limited" }, { ...base, "Retry-After": String(reset), "Cache-Control": "no-store" }, "application/problem+json");
          return;
        }

        const candidates = routes.filter(([, re]) => re.test(url.pathname));
        const route = candidates.find(([m]) => m === req.method);
        if (!route) {
          if (candidates.length > 0) {
            send(res, 405, { type: "about:blank", title: "Method not allowed", status: 405, code: "method_not_allowed" }, { ...base, Allow: candidates.map(([m]) => m).join(", ") }, "application/problem+json");
          } else {
            throw new Problem(404, "not_found", "Not found");
          }
          return;
        }
        const params = (route[1].exec(url.pathname) ?? []).slice(1);
        const a = await route[2](req, url, params);
        const headers: Record<string, string> = { ...base, "Cache-Control": a.cache, ...(a.link ? { Link: a.link } : {}) };
        if (a.cache !== "public, max-age=30") headers.Pragma = "no-cache";
        if (a.etag && a.body !== undefined) {
          const etag = `"${createHash("sha256").update(JSON.stringify(a.body)).digest("base64url").slice(0, 27)}"`;
          headers.ETag = etag;
          if (req.headers["if-none-match"] === etag) {
            send(res, 304, undefined, headers);
            return;
          }
        }
        send(res, a.status, a.body, headers);
      } catch (e) {
        if (e instanceof OAuthError) {
          send(res, 400, { error: e.error, ...(e.description ? { error_description: e.description } : {}) }, { ...base, "Cache-Control": "no-store", Pragma: "no-cache" });
        } else if (e instanceof Problem) {
          send(res, e.status, { type: "about:blank", title: e.title, status: e.status, code: e.code, ...(e.detail ? { detail: e.detail } : {}), instance: url.pathname },
            { ...base, "Cache-Control": "no-store", ...(e.status === 401 ? { "WWW-Authenticate": 'Bearer realm="pt", error="invalid_token"' } : {}) }, "application/problem+json");
        } else if (e instanceof RangeError) {
          send(res, 400, { type: "about:blank", title: "Invalid cursor", status: 400, code: "invalid_cursor", instance: url.pathname }, { ...base, "Cache-Control": "no-store" }, "application/problem+json");
        } else {
          send(res, 500, { type: "about:blank", title: "Internal error", status: 500, code: "internal" }, { ...base, "Cache-Control": "no-store" }, "application/problem+json");
        }
      }
    })();
  });
}
