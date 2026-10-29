import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";

/** Chain ID reserved for the local Besu dev network (must equal DeployLib.LOCAL_DEV_CHAIN_ID). */
export const LOCAL_DEV_CHAIN_ID = 586_586;

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    PG_HOST: z.string().min(1),
    PG_PORT: z.coerce.number().int().min(1).max(65_535),
    PG_DATABASE: z.string().regex(/^[a-z_][a-z0-9_]*$/, "lower-case identifier"),
    PG_USER: z.string().min(1),
    PG_PASSWORD: z.string().min(16, "use a generated password of at least 16 characters"),
    PG_SSL: z.enum(["disable", "require"]).default("disable"),
    CHAIN_RPC_URL: z.url().default("http://127.0.0.1:8545"),
    CHAIN_ID: z.coerce.number().int().positive().default(LOCAL_DEV_CHAIN_ID),
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV !== "production") return;
    // Production must never point at local-only settings.
    if (c.CHAIN_ID === LOCAL_DEV_CHAIN_ID) {
      ctx.addIssue({ code: "custom", path: ["CHAIN_ID"], message: "local dev chain ID is not allowed in production" });
    }
    if (c.PG_SSL !== "require") {
      ctx.addIssue({ code: "custom", path: ["PG_SSL"], message: "production database connections must use TLS" });
    }
  });

export type Config = Readonly<z.infer<typeof schema>>;

/** Keys whose values must never appear in logs or error messages. */
export const SECRET_KEYS = ["PG_PASSWORD"] as const;

/**
 * Validates configuration. Fails fast with the names of bad keys only; secret values are never
 * echoed back.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${problems}`);
  }
  return Object.freeze(parsed.data);
}

/**
 * Reads a KEY=VALUE file (such as backend/.env.local) without exporting it to process.env.
 * Lines starting with # are ignored.
 */
export function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Path comes from our own code (a fixed file next to the backend), never from user input.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (!existsSync(path)) return out;
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/**
 * Per-service database roles (task T-012, migration 0029, ADR 0016). Each backend service process
 * connects as its own LOGIN role, a member of exactly one NOLOGIN group role that holds the
 * service's grants. `npm run db:service-roles` creates the logins and appends
 * `<PREFIX>_PG_USER` / `<PREFIX>_PG_PASSWORD` to the git-ignored backend/.env.local.
 */
export const SERVICE_DB_ROLES = {
  indexer: { prefix: "INDEXER", group: "pt_svc_indexer", login: "pt_indexer_app" },
  signer: { prefix: "SIGNER", group: "pt_svc_signer", login: "pt_signer_app" },
  outbox: { prefix: "OUTBOX", group: "pt_svc_outbox", login: "pt_outbox_app" },
  kyc: { prefix: "KYC", group: "pt_svc_kyc", login: "pt_kyc_app" },
  offboarding: { prefix: "OFFBOARDING", group: "pt_svc_offboarding", login: "pt_offboarding_app" },
  bank: { prefix: "BANK", group: "pt_svc_bank", login: "pt_bank_app" },
  anchor: { prefix: "ANCHOR", group: "pt_svc_anchor", login: "pt_anchor_app" },
  recon: { prefix: "RECON", group: "pt_svc_recon", login: "pt_recon_app" },
  recovery: { prefix: "RECOVERY", group: "pt_svc_recovery", login: "pt_recovery_app" },
  tax: { prefix: "TAX", group: "pt_svc_tax", login: "pt_tax_app" },
  notify: { prefix: "NOTIFY", group: "pt_svc_notify", login: "pt_notify_app" },
  exit: { prefix: "EXIT", group: "pt_svc_exit", login: "pt_exit_app" },
  transfer: { prefix: "TRANSFER", group: "pt_svc_transfer", login: "pt_transfer_app" },
  audit: { prefix: "AUDIT", group: "pt_svc_audit", login: "pt_audit_app" },
  console: { prefix: "CONSOLE", group: "pt_svc_console", login: "pt_console_app" },
  vault: { prefix: "VAULT", group: "pt_svc_vault", login: "pt_vault_app" },
} as const;

export type ServiceName = keyof typeof SERVICE_DB_ROLES;
export interface ServiceRole {
  prefix: string;
  group: string;
  login: string;
}

/** The roles of one service. */
export function serviceRole(service: ServiceName): ServiceRole {
  // eslint-disable-next-line security/detect-object-injection -- service is a key of the constant above, never user input
  return SERVICE_DB_ROLES[service];
}

/** Every service with its roles, in a fixed order. */
export function serviceRoles(): [ServiceName, ServiceRole][] {
  return Object.entries(SERVICE_DB_ROLES) as [ServiceName, ServiceRole][];
}

/** A value from an env-style record by a computed key (`<PREFIX>_PG_USER`), without prototype lookups. */
export function envValue(env: Record<string, string | undefined>, key: string): string | undefined {
  return new Map(Object.entries(env)).get(key);
}

/** The explicit opt-in for a service to use the admin login on a loopback database (development only). */
export const ADMIN_FALLBACK_FLAG = "PT_DB_ADMIN_FALLBACK";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Whether a PostgreSQL host is this machine (the only place the admin fallback may ever apply). */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

export interface ServiceDbLogin {
  user: string;
  password: string | undefined;
  /** True only for the explicit local-development fallback to the admin login. */
  asAdmin: boolean;
}

/**
 * The database login of one backend service (fail closed):
 * - `<PREFIX>_PG_USER` and `<PREFIX>_PG_PASSWORD` set: that login (never the admin's name);
 * - otherwise the admin login ONLY when the database host is loopback, NODE_ENV is not production
 *   and PT_DB_ADMIN_FALLBACK=1 says so explicitly;
 * - anything else throws, so a service never silently runs as the schema owner.
 * Error messages name settings, never values.
 */
export function serviceDbLogin(env: Record<string, string | undefined>, service: ServiceName): ServiceDbLogin {
  const { prefix } = serviceRole(service);
  const admin = env.PG_ADMIN_USER ?? "pt_admin";
  const user = envValue(env, `${prefix}_PG_USER`);
  const password = envValue(env, `${prefix}_PG_PASSWORD`);
  if (user || password) {
    if (!user || !password) throw new Error(`${prefix}_PG_USER and ${prefix}_PG_PASSWORD must be set together`);
    if (user === admin || user === "postgres") throw new Error(`${prefix}_PG_USER must be the ${service} service's own role, not the admin`);
    return { user, password, asAdmin: false };
  }
  const host = env.PG_HOST ?? "127.0.0.1";
  const hint = "run `npm run db:service-roles` in backend/";
  if (!isLoopbackHost(host)) {
    throw new Error(`refusing to connect the ${service} service to a non-local database as the admin: set ${prefix}_PG_USER/${prefix}_PG_PASSWORD (${hint})`);
  }
  if (env.NODE_ENV === "production") throw new Error(`the ${service} service never runs as the admin in production: set ${prefix}_PG_USER/${prefix}_PG_PASSWORD`);
  if (env.PT_DB_ADMIN_FALLBACK !== "1") {
    throw new Error(`no ${prefix}_PG_USER for the ${service} service: ${hint} (local development only: ${ADMIN_FALLBACK_FLAG}=1 uses the admin login)`);
  }
  return { user: admin, password: env.PG_ADMIN_PASSWORD, asAdmin: true };
}

/** `serviceDbLogin` for a pg pool; warns on stderr (no values) when the development fallback is used. */
export function servicePgAuth(env: Record<string, string | undefined>, service: ServiceName): { user: string; password: string | undefined } {
  const login = serviceDbLogin(env, service);
  if (login.asAdmin) process.stderr.write(`WARNING: the ${service} service uses the admin database login (${ADMIN_FALLBACK_FLAG}=1, local development only)\n`);
  return { user: login.user, password: login.password };
}
