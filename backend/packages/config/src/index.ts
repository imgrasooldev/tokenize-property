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
