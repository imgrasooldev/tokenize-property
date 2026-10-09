/**
 * Live Demo Console: a LOCAL-ONLY dashboard for team presentations.
 *   cd backend && npm run demo        -> http://127.0.0.1:4800
 *
 * Shows the local Besu network, the token, live events and the ledger, and offers demo actions.
 * Hardening even though it is local: binds 127.0.0.1 only, rejects foreign Host headers (DNS
 * rebinding), requires a per-run token and same-origin for actions (CSRF), strict CSP with nonces,
 * and never sends private keys to the browser.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { readEnvFile } from "@pt/config";
import { createLogger } from "@pt/logger";
import pg from "pg";
import { rentCycle, runScript, tamperDemo } from "./actions.ts";
import { ROOT } from "./local.ts";
import { DemoState } from "./state.ts";

const HOST = "127.0.0.1";
const PORT = 4800;
const ORIGIN = `http://${HOST}:${PORT}`;
const ALLOWED_HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));
const TOKEN = randomBytes(24).toString("hex");
const log = createLogger({ service: "demo-console" });

// Fixed file shipped with this package.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const html = readFileSync(fileURLToPath(new URL("../public/index.html", import.meta.url)), "utf8");

const env = readEnvFile(`${ROOT}backend/.env.local`);
const adminSettings: pg.ClientConfig = {
  host: env.PG_HOST ?? HOST,
  port: Number(env.PG_PORT ?? 5433),
  user: env.PG_ADMIN_USER ?? "pt_admin",
  password: env.PG_ADMIN_PASSWORD ?? "",
};

let ledgerDb: pg.Pool | null = null;
try {
  ledgerDb = new pg.Pool({ ...adminSettings, database: "property_token", application_name: "demo-console", max: 4 });
  await ledgerDb.query("SELECT 1");
} catch (e) {
  log.warn({ err: (e as Error).message }, "ledger database not reachable; ledger panel disabled");
  ledgerDb = null;
}

const state = new DemoState(ledgerDb);
const streams = new Set<ServerResponse>();
let busy: string | null = null;

function send(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of streams) res.write(payload);
}
const consoleLog = (line: string) => {
  send("log", { at: new Date().toISOString(), line });
};

function securityHeaders(res: ServerResponse, nonce?: string): void {
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce ?? "none"}'; style-src 'nonce-${nonce ?? "none"}'; ` +
      "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 1024) throw new Error("body too large");
  }
  return body;
}

async function runAction(action: string, node: number | undefined): Promise<void> {
  busy = action;
  send("busy", { action });
  try {
    switch (action) {
      case "scenario":
        consoleLog("Running the full scenario: deploy through DeployLib, then 50 on-chain checks…");
        consoleLog(`Finished with exit code ${await runScript(["chain/flow.py"], consoleLog)}`);
        break;
      case "network-start":
        await runScript(["chain/net.py", "start"], consoleLog);
        break;
      case "network-stop":
        await runScript(["chain/net.py", "stop"], consoleLog);
        break;
      case "node-stop":
      case "node-start":
        if (!node || node < 1 || node > 4) throw new Error("node must be 1-4");
        await runScript(["chain/net.py", action === "node-stop" ? "stop" : "start", `node${node}`], consoleLog);
        break;
      case "rent-cycle":
        if (!ledgerDb) throw new Error("ledger database not reachable (python backend/scripts/pg.py start)");
        await rentCycle(ledgerDb, consoleLog);
        break;
      case "tamper-demo":
        await tamperDemo(adminSettings, consoleLog);
        break;
      default:
        throw new Error(`unknown action ${action}`);
    }
  } catch (e) {
    consoleLog(`Error: ${(e as Error).message}`);
  } finally {
    busy = null;
    send("busy", { action: null });
  }
}

const server = createServer((req, res) => {
  void (async () => {
    // DNS-rebinding protection: only our exact host names.
    if (!ALLOWED_HOSTS.has(req.headers.host ?? "")) {
      res.writeHead(403).end("forbidden host");
      return;
    }
    const url = new URL(req.url ?? "/", ORIGIN);

    if (req.method === "GET" && url.pathname === "/") {
      const nonce = randomBytes(16).toString("base64");
      securityHeaders(res, nonce);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html.replaceAll("__NONCE__", nonce).replace("__DEMO_TOKEN__", TOKEN));
      return;
    }

    if (req.method === "GET" && url.pathname === "/stream") {
      securityHeaders(res);
      res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
      streams.add(res);
      res.write(`event: busy\ndata: ${JSON.stringify({ action: busy })}\n\n`);
      req.on("close", () => streams.delete(res));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/action") {
      securityHeaders(res);
      // CSRF protection: same origin and the per-run token embedded in our own page.
      if (!ALLOWED_ORIGINS.has(req.headers.origin ?? "") || req.headers["x-demo-token"] !== TOKEN) {
        res.writeHead(403).end("forbidden");
        return;
      }
      if (busy) {
        res.writeHead(409, { "Content-Type": "application/json" }).end(JSON.stringify({ error: `busy: ${busy}` }));
        return;
      }
      let parsed: { action?: unknown; node?: unknown };
      try {
        parsed = JSON.parse(await readBody(req)) as { action?: unknown; node?: unknown };
      } catch {
        res.writeHead(400).end("bad request");
        return;
      }
      if (typeof parsed.action !== "string") {
        res.writeHead(400).end("bad request");
        return;
      }
      void runAction(parsed.action, typeof parsed.node === "number" ? parsed.node : undefined);
      res.writeHead(202, { "Content-Type": "application/json" }).end(JSON.stringify({ accepted: parsed.action }));
      return;
    }

    res.writeHead(404).end("not found");
  })().catch((e: unknown) => {
    log.error({ err: (e as Error).message }, "request failed");
    if (!res.headersSent) res.writeHead(500).end("error");
  });
});

let ticking = false;
setInterval(() => {
  if (ticking || streams.size === 0) return;
  ticking = true;
  state
    .snapshot()
    .then((s) => {
      send("state", s);
    })
    .catch((e: unknown) => {
      log.warn({ err: (e as Error).message }, "snapshot failed");
    })
    .finally(() => {
      ticking = false;
    });
}, 2_000);

server.listen(PORT, HOST, () => {
  log.info(`Demo console on ${ORIGIN} (local only)`);
});
