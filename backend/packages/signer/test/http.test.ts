import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authHeaders, createSignerServer, SignerClient, type Client, type SignerApi } from "../src/http.ts";

const client: Client = { id: "outbox-worker", secret: Buffer.alloc(32, 7) };
const calls: string[] = [];
const api: SignerApi = {
  request: (input, by) => {
    calls.push(`sign:${by}:${input.commandRef}`);
    return Promise.resolve({ status: "pending_approval", requestId: "3f1c2b7e-9d4a-4c1e-8f2a-1b2c3d4e5f60", approvalsNeeded: 2 });
  },
  markBroadcast: () => Promise.resolve(true),
  release: () => Promise.resolve(true),
};

let server: Server;
let base: string;
beforeAll(async () => {
  server = createSignerServer(api, [client]);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(() => {
  server.close();
});

async function raw(path: string, body: string, headers: Record<string, string>) {
  return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
}

describe("signer HTTP API", () => {
  it("accepts a correctly signed request through the typed client", async () => {
    const res = await new SignerClient(base, client).sign({ commandRef: "cmd:http:1", kind: "issuance.mint", payload: {} });
    expect(res).toMatchObject({ status: "pending_approval" });
    expect(calls).toContain("sign:outbox-worker:cmd:http:1");
  });

  it("refuses missing, forged, stale and replayed signatures", async () => {
    const body = JSON.stringify({ commandRef: "cmd:http:2", kind: "issuance.mint", payload: {} });
    expect((await raw("/v1/sign", body, {})).status).toBe(401);
    const forged = { ...authHeaders(client, "POST", "/v1/sign", body), "x-pt-sig": "0".repeat(64) };
    expect((await raw("/v1/sign", body, forged)).status).toBe(401);
    const stale = authHeaders(client, "POST", "/v1/sign", body, Date.now() - 120_000);
    expect((await raw("/v1/sign", body, stale)).status).toBe(401);
    const other = authHeaders({ id: "outbox-worker", secret: Buffer.alloc(32, 8) }, "POST", "/v1/sign", body);
    expect((await raw("/v1/sign", body, other)).status).toBe(401);
    const once = authHeaders(client, "POST", "/v1/sign", body);
    expect((await raw("/v1/sign", body, once)).status).toBe(200);
    expect((await raw("/v1/sign", body, once)).status).toBe(401); // replay
    const tampered = authHeaders(client, "POST", "/v1/sign", body);
    expect((await raw("/v1/sign", body.replace("cmd:http:2", "cmd:http:9"), tampered)).status).toBe(401);
    const wrongPath = authHeaders(client, "POST", "/v1/release", body);
    expect((await raw("/v1/sign", body, wrongPath)).status).toBe(401);
  });

  it("refuses oversized bodies, non-JSON and unknown routes, and never echoes internals", async () => {
    const big = JSON.stringify({ x: "a".repeat(40_000) });
    expect((await raw("/v1/sign", big, authHeaders(client, "POST", "/v1/sign", big))).status).toBe(413);
    const res = await fetch(`${base}/v1/sign`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
    expect(res.status).toBe(415);
    expect((await fetch(`${base}/admin`)).status).toBe(404);
    const bad = JSON.stringify({ commandRef: "x", kind: "nope", payload: 1 });
    const r = await raw("/v1/broadcast", bad, authHeaders(client, "POST", "/v1/broadcast", bad));
    expect(r.status).toBe(400);
    expect(await r.text()).toBe('{"error":"bad_request"}');
    expect((await fetch(`${base}/v1/health`)).status).toBe(200);
  });
});
