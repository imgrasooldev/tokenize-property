import { createServer, type Server } from "node:http";
import { HmacAuthenticator, readBody, sendJson, type Client } from "@pt/http-auth";
import { z } from "zod";
import { KycError, type OnboardInput, type OnboardResult } from "./service.ts";

/**
 * Internal HTTP API of the KYC service (Step 5h, ADR 0010), for the website's sign-up. Same
 * authentication as the signing service (@pt/http-auth: HMAC over method, path, time, one-time
 * nonce and body; client scopes). Bound to 127.0.0.1 (production: private network + mTLS).
 * Personal data is only passed through to the KYC service in memory: it is never logged, never
 * echoed in a response, and the response carries the subject, the derived status and the outcome
 * of each check only.
 */
export interface KycApi {
  onboard(input: OnboardInput): Promise<OnboardResult>;
  /** S-06 RF-8: re-verification of an existing subject for a wallet recovery. */
  reverify?(input: Omit<OnboardInput, "wallet">): Promise<OnboardResult>;
}

export const WEB_KYC_SCOPE = ["/v1/onboard"] as const;
/** The branch / video-call re-verification client of a wallet recovery (S-06): re-verify only. */
export const RECOVERY_KYC_SCOPE = ["/v1/reverify"] as const;
const PATHS = ["/v1/onboard", "/v1/reverify"];
const MAX_BODY = 4 * 1024;

const onboardBody = z.strictObject({
  cnic: z.string().min(13).max(15),
  fullName: z.string().min(2).max(140),
  livenessSessionId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
  wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});
const reverifyBody = z.strictObject({
  cnic: z.string().min(13).max(15),
  fullName: z.string().min(2).max(140),
  livenessSessionId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
});

export function createKycServer(api: KycApi, clients: Client[], opts: { now?: () => number } = {}): Server {
  const auth = new HmacAuthenticator(clients, opts.now);
  return createServer((req, res) => {
    void (async () => {
      try {
        const path = new URL(req.url ?? "/", "http://internal").pathname;
        if (req.method === "GET" && path === "/v1/health") {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (req.method !== "POST" || !PATHS.includes(path) || (path === "/v1/reverify" && !api.reverify)) {
          sendJson(res, 404, { error: "not_found" });
          return;
        }
        if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
          sendJson(res, 415, { error: "json_only" });
          return;
        }
        const body = await readBody(req, MAX_BODY);
        if (body === null) {
          sendJson(res, 413, { error: "too_large" });
          return;
        }
        const a = auth.authenticate(req, path, body);
        if (!a.ok) {
          sendJson(res, a.status, { error: a.status === 403 ? "forbidden" : "unauthorized" });
          return;
        }
        let json: unknown;
        try {
          json = JSON.parse(body);
        } catch {
          sendJson(res, 400, { error: "bad_json" });
          return;
        }
        if (path === "/v1/reverify" && api.reverify) {
          const re = reverifyBody.safeParse(json);
          if (!re.success) {
            sendJson(res, 400, { error: "invalid" });
            return;
          }
          const r = await api.reverify(re.data);
          sendJson(res, 200, { subjectId: r.subjectId, status: r.status, reason: r.reason, checks: r.checks });
          return;
        }
        const parsed = onboardBody.safeParse(json);
        if (!parsed.success) {
          sendJson(res, 400, { error: "invalid" });
          return;
        }
        const r = await api.onboard(parsed.data);
        sendJson(res, 200, { subjectId: r.subjectId, status: r.status, reason: r.reason, checks: r.checks });
      } catch (e) {
        if (e instanceof KycError && e.code === "UNKNOWN_SUBJECT") sendJson(res, 404, { error: "not_found" });
        else if (e instanceof KycError) sendJson(res, e.code === "DUPLICATE_CNIC" ? 409 : 400, { error: e.code === "DUPLICATE_CNIC" ? "duplicate" : "invalid" });
        else sendJson(res, 500, { error: "internal" });
      }
    })();
  });
}
