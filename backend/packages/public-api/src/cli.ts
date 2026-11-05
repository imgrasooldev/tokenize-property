import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readEnvFile, servicePgAuth } from "@pt/config";
import { PushSealer } from "@pt/notify";
import pg from "pg";
import { createApiServer } from "./http.ts";
import { pgRepositories } from "./repositories.ts";
import { AuthService, CatalogueService, InvestorService, PushService } from "./services.ts";

/**
 * Public API for the mobile app (ADR 0018, migration 0058).
 *   npm run public-api     serve /v1 on 127.0.0.1:PUBLIC_API_PORT (4960); nginx publishes it as /v1/
 * Connects as PUBLIC_API_PG_USER (group pt_svc_public_api: papi.* functions only). The device
 * verification page is the website's /device (WEB_PUBLIC_URL).
 */
const BACKEND = fileURLToPath(new URL("../../../", import.meta.url));
const OPENAPI = fileURLToPath(new URL("../../../../docs/api/openapi.json", import.meta.url));

function env(): Record<string, string | undefined> {
  return { ...readEnvFile(`${BACKEND}.env.local`), ...process.env };
}

function main(): void {
  const e = env();
  const db = new pg.Pool({
    host: e.PG_HOST ?? "127.0.0.1",
    port: Number(e.PG_PORT ?? 5433),
    ...servicePgAuth(e, "public_api"),
    database: e.PG_DATABASE ?? "property_token",
    application_name: "public-api",
    max: 8,
    statement_timeout: 10_000,
    connectionTimeoutMillis: 5_000,
  });
  const repos = pgRepositories(db);
  // Push (migration 0065): the public half of the worker's key; without it the push routes answer 503.
  const sealer = e.NOTIFY_PUSH_PUBLIC_KEY ? PushSealer.fromEnv(e) : null;
  const web = (e.WEB_PUBLIC_URL ?? "http://localhost:3100").replace(/\/$/, "");
  const server = createApiServer({
    auth: new AuthService(repos.grants, `${web}/device`),
    catalogue: new CatalogueService(repos.catalogue),
    investors: new InvestorService(repos.investors, `${web}/confirm`),
    push: new PushService(repos.push, sealer),
    // DPoP htu (RFC 9449): the URL the app calls through nginx.
    publicUrl: e.PUBLIC_API_URL ?? `${web}/v1`,
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path of the contract in the repository
    openapi: JSON.parse(readFileSync(OPENAPI, "utf8")) as unknown,
  });
  const port = Number(e.PUBLIC_API_PORT ?? 4960);
  server.listen(port, "127.0.0.1", () => {
    console.log(`public API listening on 127.0.0.1:${String(port)} (/v1)`);
  });
  const stop = (): void => {
    server.close(() => void db.end());
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main();
