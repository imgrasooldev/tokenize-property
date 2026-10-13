import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { authHeaders, type Client } from "@pt/http-auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKycServer, WEB_KYC_SCOPE, type KycApi } from "../src/http.ts";
import { KycError, type OnboardInput } from "../src/service.ts";

/** The KYC service API for the website's sign-up (ADR 0010): authentication, validation, no personal data out. */
const web: Client = { id: "web", secret: Buffer.alloc(32, 3), scope: WEB_KYC_SCOPE };
const seen: OnboardInput[] = [];
const api: KycApi = {
  onboard: (input) => {
    seen.push(input);
    if (input.cnic.endsWith("7")) return Promise.reject(new KycError("DUPLICATE_CNIC", "this CNIC is already registered"));
    return Promise.resolve({ subjectId: "5b0b2c1e-9d4a-4c1e-8f2a-1b2c3d4e5f60", status: "verified", reason: "all checks passed", checks: [{ kind: "nadra", outcome: "pass", reason: "match" }] });
  },
};

let server: Server;
let base: string;
beforeAll(async () => {
  server = createKycServer(api, [web]);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(() => {
  server.close();
});

const body = (cnic = "42101-1234567-1") => JSON.stringify({ cnic, fullName: "Ayesha Khan", livenessSessionId: "web-session-0001", wallet: `0x${"12".repeat(20)}` });
const post = (b: string, headers: Record<string, string>) => fetch(`${base}/v1/onboard`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: b });

describe("KYC service API", () => {
  it("onboards through the service and answers with the subject and derived status only", async () => {
    const b = body();
    const res = await post(b, authHeaders(web, "POST", "/v1/onboard", b));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ status: "verified", subjectId: expect.any(String) as unknown });
    expect(text).not.toMatch(/1234567|Ayesha/);
    expect(seen.at(-1)?.fullName).toBe("Ayesha Khan");
  });

  it("refuses unauthenticated, replayed and malformed requests, and maps a duplicate CNIC to 409", async () => {
    const b = body();
    expect((await post(b, {})).status).toBe(401);
    const h = authHeaders(web, "POST", "/v1/onboard", b);
    expect((await post(b, h)).status).toBe(200);
    expect((await post(b, h)).status).toBe(401);
    const bad = JSON.stringify({ cnic: "1", fullName: "x", livenessSessionId: "s", wallet: "0x1", extra: true });
    const r = await post(bad, authHeaders(web, "POST", "/v1/onboard", bad));
    expect(r.status).toBe(400);
    expect(await r.text()).toBe('{"error":"invalid"}');
    const dup = body("42101-1234567-7");
    const d = await post(dup, authHeaders(web, "POST", "/v1/onboard", dup));
    expect(d.status).toBe(409);
    expect(await d.text()).toBe('{"error":"duplicate"}');
    expect((await fetch(`${base}/v1/health`)).status).toBe(200);
    expect((await fetch(`${base}/v1/other`, { method: "POST" })).status).toBe(404);
  });
});
