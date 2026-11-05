import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { PushTokenGone, ProviderRejected, ProviderUnavailable, type LookupResult, type OutboundMessage, type Provider } from "./providers.ts";

/**
 * Firebase Cloud Messaging HTTP v1 (migration 0065, ADR 0018 amendment 6). Android and iOS (APNs
 * through FCM). Authenticates with a Google service account (OAuth 2.0 JWT bearer grant, RFC 7523);
 * the account file stays outside the repository (FCM_SERVICE_ACCOUNT_FILE).
 *
 * Mapping to the worker's contract (providers.ts):
 *  - 200: accepted; the message id is FCM's message name.
 *  - 404 / UNREGISTERED: the token is gone (PushTokenGone; the worker supersedes the contact).
 *  - 400 / 403 (invalid token, other project): refused for good (ProviderRejected).
 *  - 401, 429, 5xx and a connection that never opened: FCM did not accept it (ProviderUnavailable).
 *  - Anything else, including a timeout after the request was sent: outcome unknown.
 * FCM has no idempotency key and no lookup, so `lookup` answers "unknown": an unknown outcome is
 * dead-lettered after the review time, never sent twice.
 */

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri: string;
}

export interface FcmOptions {
  account: ServiceAccount;
  fetch?: typeof fetch;
  now?: () => number;
}

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TITLE = { en: "Property Token", ur: "پراپرٹی ٹوکن" } as const;
const NOT_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

export function readServiceAccount(path: string): ServiceAccount {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the operator's FCM_SERVICE_ACCOUNT_FILE
  const j = JSON.parse(readFileSync(path, "utf8")) as Partial<ServiceAccount>;
  if (
    typeof j.project_id !== "string" ||
    !/^[a-z][a-z0-9-]{4,62}$/.test(j.project_id) ||
    typeof j.client_email !== "string" ||
    typeof j.private_key !== "string" ||
    typeof j.token_uri !== "string" ||
    !j.token_uri.startsWith("https://")
  ) {
    throw new Error("FCM service account file must have project_id, client_email, private_key and an https token_uri");
  }
  return { project_id: j.project_id, client_email: j.client_email, private_key: j.private_key, token_uri: j.token_uri };
}

function b64url(s: string | Buffer): string {
  return Buffer.from(s).toString("base64url");
}

/** True when the error says the connection never opened (nothing was sent). */
function neverConnected(e: unknown): boolean {
  const cause = (e as { cause?: { code?: unknown } }).cause;
  return e instanceof TypeError && typeof cause?.code === "string" && NOT_SENT.has(cause.code);
}

export class FcmProvider implements Provider {
  readonly name = "fcm";
  readonly channel = "push" as const;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private access: { token: string; until: number } | null = null;

  constructor(private readonly opts: FcmOptions) {
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  private async accessToken(signal: AbortSignal): Promise<string> {
    const t = this.now();
    if (this.access && this.access.until > t + 60_000) return this.access.token;
    const a = this.opts.account;
    const iat = Math.floor(t / 1000);
    const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss: a.client_email, scope: SCOPE, aud: a.token_uri, iat, exp: iat + 3600 }))}`;
    const jwt = `${unsigned}.${b64url(createSign("RSA-SHA256").update(unsigned).sign(a.private_key))}`;
    let res: Response;
    try {
      res = await this.fetch(a.token_uri, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }).toString(),
        signal,
      });
    } catch (e) {
      // No message was sent yet, whatever happened to the token request.
      throw new ProviderUnavailable(`fcm: token request failed (${(e as Error).message})`);
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown };
    if (!res.ok || typeof body.access_token !== "string") throw new ProviderUnavailable(`fcm: token request answered ${String(res.status)}`);
    const seconds = typeof body.expires_in === "number" ? body.expires_in : 3600;
    this.access = { token: body.access_token, until: t + seconds * 1000 };
    return body.access_token;
  }

  async send(message: OutboundMessage, signal: AbortSignal): Promise<{ messageId: string }> {
    if (message.channel !== "push") throw new ProviderRejected("fcm sends push only");
    const token = await this.accessToken(signal);
    let res: Response;
    try {
      res = await this.fetch(`https://fcm.googleapis.com/v1/projects/${this.opts.account.project_id}/messages:send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            token: message.to,
            notification: { title: TITLE[message.locale], body: message.text },
            data: { delivery: message.idempotencyKey },
            android: { priority: "high" },
          },
        }),
        signal,
      });
    } catch (e) {
      if (neverConnected(e)) throw new ProviderUnavailable(`fcm: connection failed (${(e as Error).message})`);
      throw e;
    }
    const body = (await res.json().catch(() => ({}))) as { name?: unknown; error?: { status?: unknown; details?: { errorCode?: unknown }[] } };
    if (res.ok && typeof body.name === "string") return { messageId: body.name.slice(-120) };
    const code = body.error?.details?.find((d) => typeof d.errorCode === "string")?.errorCode;
    if (res.status === 404 || code === "UNREGISTERED") throw new PushTokenGone("fcm: the device token is no longer registered");
    if (res.status === 400 || res.status === 403) throw new ProviderRejected(`fcm: refused (${String(res.status)} ${typeof code === "string" ? code : ""})`);
    if (res.status === 401) this.access = null;
    if (res.status === 401 || res.status === 429 || res.status >= 500) throw new ProviderUnavailable(`fcm: not accepted (${String(res.status)})`);
    throw new Error(`fcm: unexpected answer ${String(res.status)}`);
  }

  lookup(): Promise<LookupResult> {
    return Promise.resolve({ state: "unknown" });
  }
}
