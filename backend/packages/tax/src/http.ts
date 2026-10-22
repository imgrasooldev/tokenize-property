import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { HmacAuthenticator, readBody, sendJson, type Client } from "@pt/http-auth";
import { z } from "zod";
import { officerMessage, type ExportFile } from "./service.ts";

/**
 * Internal HTTP API of the tax service (ADR 0014): one path, for the admin portal, which generates
 * an approved FBR filing export with the one-time ticket the admin database issued to one of the
 * export's two officers (after a fresh security-key step-up). HMAC client authentication with
 * scopes (@pt/http-auth); 127.0.0.1 only (production: private network + mTLS). The response
 * carries the file once; nothing is logged about its content.
 */
export interface TaxApi {
  generateExport(exportId: string, ticketHash: Buffer): Promise<ExportFile>;
}

export const ADMIN_TAX_SCOPE = ["/v1/filing-exports/generate"] as const;
const MAX_BODY = 1024;

const generateBody = z.strictObject({
  exportId: z.string().regex(/^[1-9][0-9]{0,17}$/),
  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export function createTaxServer(api: TaxApi, clients: Client[], opts: { now?: () => number; onError?: (e: unknown) => void } = {}): Server {
  const auth = new HmacAuthenticator(clients, opts.now);
  return createServer((req, res) => {
    void (async () => {
      try {
        const path = new URL(req.url ?? "/", "http://internal").pathname;
        if (req.method === "GET" && path === "/v1/health") {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (req.method !== "POST" || path !== "/v1/filing-exports/generate") {
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
        let parsed: z.infer<typeof generateBody>;
        try {
          parsed = generateBody.parse(JSON.parse(body));
        } catch {
          sendJson(res, 400, { error: "bad_request" });
          return;
        }
        const ticketHash = createHash("sha256").update(Buffer.from(parsed.ticket, "base64url")).digest();
        try {
          const f = await api.generateExport(parsed.exportId, ticketHash);
          sendJson(res, 200, { fileName: f.fileName, csv: f.csv.toString("base64"), sha256: f.sha256, rows: f.rows, record: f.record });
        } catch (e) {
          const msg = officerMessage(e);
          if (msg) {
            sendJson(res, 409, { error: msg });
            return;
          }
          throw e;
        }
      } catch (e) {
        // Never echo internals (or anything that might carry personal data) to the caller.
        opts.onError?.(e);
        if (!res.headersSent) sendJson(res, 500, { error: "internal" });
      }
    })();
  });
}
