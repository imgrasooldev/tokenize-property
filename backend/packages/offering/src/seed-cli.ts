import { fileURLToPath } from "node:url";
import { readEnvFile } from "@pt/config";
import pg from "pg";
import { seedCatalog } from "./seed.ts";

/**
 * DEMO CATALOG, run from backend/ (local / demo databases only):
 *   npm run seed:catalog                  onboard the two demo properties through S-01 and S-02 (idempotent)
 *   npm run seed:catalog -- --token 0x..  also record a deployed, paused token (L4) if the read model allows it
 * Officers: DEMO_CATALOG_OFFICERS='{"onboardingMaker":"amna.k", ...}' overrides the demo handles.
 * Exit codes: 0 done or skipped (missing officers/secrets: nothing written), 1 refused or failed, 2 usage.
 */
const BACKEND = fileURLToPath(new URL("../../../", import.meta.url));

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let token: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args.at(i);
    if (a === "--token" && /^0x[0-9a-fA-F]{40}$/.test(args.at(i + 1) ?? "")) {
      token = args.at(i + 1);
      i++;
    } else {
      out("usage: npm run seed:catalog [-- --token 0x<40 hex>]");
      process.exitCode = 2;
      return;
    }
  }
  const e: Record<string, string | undefined> = { ...readEnvFile(`${BACKEND}.env.local`), ...process.env };
  const db = new pg.Pool({
    host: e.PG_HOST ?? "127.0.0.1",
    port: Number(e.PG_PORT ?? 5433),
    user: e.PG_ADMIN_USER ?? "pt_admin",
    password: e.PG_ADMIN_PASSWORD,
    database: e.PG_DATABASE ?? "property_token",
    application_name: "seed-catalog",
    max: 3,
  });
  try {
    const r = await seedCatalog(db, { env: e, ...(token ? { token } : {}), log: out });
    if (r.status === "refused") {
      out(`seed:catalog refused: ${r.reason}`);
      process.exitCode = 1;
    } else if (r.status === "skipped") {
      out("seed:catalog skipped: nothing was written");
      for (const p of r.problems) out(`  - ${p}`);
      if (r.plan.length) {
        out("An administrator must enrol these officers in PT Control (admin portal) first:");
        for (const p of r.plan) out(`  * ${p}`);
      }
    } else if (r.properties.some((p) => p.outcome === "failed" || p.outcome === "blocked")) {
      process.exitCode = 1;
    }
  } finally {
    await db.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`seed:catalog: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
