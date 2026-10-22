import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Portal settings. Environment variables win; locally they come from admin/.env.local (written by
 * `npm run setup:local` and backend `npm run signer:admin-client`, git-ignored). Two secrets exist:
 * the database password and the signing service client secret (Step 6b: preview and decide only).
 * Session tokens are random and only their hashes are stored; CSRF tokens derive from the session.
 */
function localEnv(): Map<string, string> {
  const env = new Map<string, string>();
  const file = join(process.cwd(), ".env.local");
  // Fixed path inside the app directory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (existsSync(file)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq > 0 && !line.startsWith("#")) env.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
  }
  return env;
}

const local = localEnv();
const env = new Map(Object.entries(process.env));
function setting(name: string, fallback?: string): string | undefined {
  return env.get(name) ?? local.get(name) ?? fallback;
}

/**
 * The one origin officers use. WebAuthn needs a secure context, so it is either https://... in
 * production or http://localhost:<port> through an SSH tunnel (browsers treat localhost as secure,
 * including for Secure and __Host- cookies). An IP address cannot be a WebAuthn RP ID.
 */
const origin = new URL(setting("ADMIN_ORIGIN", "http://localhost:3300") ?? "http://localhost:3300");
if (origin.protocol !== "https:" && origin.hostname !== "localhost") {
  throw new Error("ADMIN_ORIGIN must be https://... or http://localhost:<port> (WebAuthn needs a secure context)");
}

export const config = {
  origin: origin.origin,
  host: origin.host,
  rpID: origin.hostname,
  rpName: "Property Token Control",
  https: origin.protocol === "https:",
  chainRpcUrl: setting("CHAIN_RPC_URL", "http://127.0.0.1:8545") ?? "http://127.0.0.1:8545",
  trustProxy: setting("ADMIN_TRUST_PROXY") === "1",
  /**
   * The signing service (ADR 0005) and the portal's own client (scope: preview and decide only,
   * never sign). Without a secret the portal shows signing requests but cannot decide them.
   */
  signer: {
    url: setting("SIGNER_URL", "http://127.0.0.1:4900") ?? "http://127.0.0.1:4900",
    clientId: "admin-portal",
    secret: setting("SIGNER_CLIENT_SECRET_ADMIN", "") ?? "",
  },
  /**
   * The tax service (ADR 0014) and the portal's client (scope: generate an approved FBR filing
   * export with a one-time ticket, nothing else). Without a secret no export can be generated.
   */
  taxService: {
    url: setting("TAX_SERVICE_URL", "http://127.0.0.1:4940") ?? "http://127.0.0.1:4940",
    clientId: "admin-portal",
    secret: setting("TAX_CLIENT_SECRET_ADMIN", "") ?? "",
  },
  db: {
    host: setting("ADMIN_PG_HOST", "127.0.0.1") ?? "127.0.0.1",
    port: Number(setting("ADMIN_PG_PORT", "5433")),
    database: setting("ADMIN_PG_DATABASE", "pt_admin_dev") ?? "pt_admin_dev",
    user: setting("ADMIN_PG_USER", "pt_admin_web") ?? "pt_admin_web",
    password: setting("ADMIN_PG_PASSWORD", "") ?? "",
    ssl: setting("ADMIN_PG_SSL") === "require",
  },
} as const;

/** Session cookie: always Secure + __Host- (bound to this exact origin, no Domain, Path=/). */
export const SESSION_COOKIE = "__Host-pt_admin";
/** Binds a WebAuthn ceremony (its challenge) to the browser that started it; 5 minutes. */
export const CEREMONY_COOKIE = "__Host-pt_admin_ceremony";
