import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FcmProvider, type ServiceAccount } from "../src/fcm.ts";
import { MockProvider, ProviderRejected, ProviderUnavailable, PushTokenGone, type OutboundMessage } from "../src/providers.ts";
import { newPushKeyPair, PushOpener, PushSealer } from "../src/push.ts";
import { enqueue, NotifyService } from "../src/service.ts";
import { NotifyWorker } from "../src/worker.ts";
import { servicePool } from "../../db/test/helpers.ts";
import { investor, makeNotifyDb, type NotifyDb } from "./helpers.ts";

/** Push (migration 0065): sealing for the worker only, the FCM adapter's contract, and the worker end to end. */

const TOKEN = `dGVzdC1kZXZpY2U:APA91b${"x".repeat(140)}`;
const keys = newPushKeyPair();
const sealer = PushSealer.fromEnv({ NOTIFY_PUSH_PUBLIC_KEY: keys.publicKey });
const opener = PushOpener.fromEnv({ NOTIFY_PUSH_PRIVATE_KEY: keys.privateKey });

describe("push token sealing (PN-2)", () => {
  it("opens only with the worker's key, for the same recipient, untampered", () => {
    const r = randomUUID();
    const { lookupHash, sealed } = sealer.seal(r, TOKEN);
    expect(sealed.length).toBeLessThanOrEqual(400);
    expect(sealed.toString("latin1")).not.toContain("APA91b");
    expect(opener.open(r, lookupHash, sealed)).toBe(TOKEN);
    // Every seal is different (fresh ephemeral key and IV).
    expect(sealer.seal(r, TOKEN).sealed.equals(sealed)).toBe(false);
    expect(() => opener.open(randomUUID(), lookupHash, sealed)).toThrow(/cannot be opened/);
    const flipped = Buffer.from(sealed);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
    expect(() => opener.open(r, lookupHash, flipped)).toThrow(/cannot be opened/);
    const otherWorker = PushOpener.fromEnv({ NOTIFY_PUSH_PRIVATE_KEY: newPushKeyPair().privateKey });
    expect(() => otherWorker.open(r, lookupHash, sealed)).toThrow(/cannot be opened/);
    expect(() => sealer.seal(r, "short")).toThrow(/not valid/);
    expect(() => PushSealer.fromEnv({ NOTIFY_PUSH_PUBLIC_KEY: keys.privateKey })).toThrow(/X25519/);
    expect(() => PushSealer.fromEnv({})).toThrow(/not set/);
  });
});

describe("FCM provider (HTTP v1)", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const account: ServiceAccount = {
    project_id: "pt-demo-push",
    client_email: "push@pt-demo-push.iam.gserviceaccount.com",
    private_key: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    token_uri: "https://oauth2.example.test/token",
  };
  const message: OutboundMessage = { idempotencyKey: randomUUID(), channel: "push", to: TOKEN, locale: "ur", text: "آپ کا اکاؤنٹ منجمد کر دیا گیا۔" };
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  function fcm(answer: (n: number) => Response | Error): { p: FcmProvider; calls: { url: string; body: string; auth: string }[] } {
    const calls: { url: string; body: string; auth: string }[] = [];
    let n = 0;
    const f = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push({ url: u, body, auth: new Headers(init?.headers).get("authorization") ?? "" });
      if (u === account.token_uri) return Promise.resolve(json(200, { access_token: "ya29.test", expires_in: 3600 }));
      const a = answer(++n);
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
    };
    return { p: new FcmProvider({ account, fetch: f }), calls };
  }

  it("signs a JWT for the token, sends the notice with the localized title and reuses the token", async () => {
    const { p, calls } = fcm(() => json(200, { name: "projects/pt-demo-push/messages/0:1234" }));
    const signal = new AbortController().signal;
    expect(await p.send(message, signal)).toEqual({ messageId: "projects/pt-demo-push/messages/0:1234" });
    await p.send(message, signal);
    expect(calls.map((c) => c.url)).toEqual([
      account.token_uri,
      "https://fcm.googleapis.com/v1/projects/pt-demo-push/messages:send",
      "https://fcm.googleapis.com/v1/projects/pt-demo-push/messages:send",
    ]);
    const assertion = new URLSearchParams(calls[0]?.body).get("assertion") ?? "";
    const claims = JSON.parse(Buffer.from(assertion.split(".")[1] ?? "", "base64url").toString()) as Record<string, unknown>;
    expect(claims).toMatchObject({ iss: account.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: account.token_uri });
    expect(calls[1]?.auth).toBe("Bearer ya29.test");
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
      message: { token: TOKEN, notification: { title: "پراپرٹی ٹوکن", body: message.text }, data: { delivery: message.idempotencyKey }, android: { priority: "high" } },
    });
    expect(await p.lookup()).toEqual({ state: "unknown" });
  });

  it("maps FCM answers to the worker's contract", async () => {
    const signal = new AbortController().signal;
    const err = (status: number, code?: string): Response => json(status, { error: { status: "X", details: code ? [{ errorCode: code }] : [] } });
    await expect(fcm(() => err(404, "UNREGISTERED")).p.send(message, signal)).rejects.toBeInstanceOf(PushTokenGone);
    await expect(fcm(() => err(400, "INVALID_ARGUMENT")).p.send(message, signal)).rejects.toBeInstanceOf(ProviderRejected);
    await expect(fcm(() => err(403, "SENDER_ID_MISMATCH")).p.send(message, signal)).rejects.toBeInstanceOf(ProviderRejected);
    for (const s of [401, 429, 500, 503]) await expect(fcm(() => err(s)).p.send(message, signal)).rejects.toBeInstanceOf(ProviderUnavailable);
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    await expect(fcm(() => refused).p.send(message, signal)).rejects.toBeInstanceOf(ProviderUnavailable);
    // Sent, then lost: the outcome is unknown (never a retry).
    const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    const unknown = await fcm(() => reset)
      .p.send(message, signal)
      .catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(Error);
    expect(unknown).not.toBeInstanceOf(ProviderUnavailable);
    expect(unknown).not.toBeInstanceOf(ProviderRejected);
  });
});

describe("worker delivers push (migration 0065)", () => {
  let t: NotifyDb;
  let workerDb: Awaited<ReturnType<typeof servicePool>>;

  beforeAll(async () => {
    t = await makeNotifyDb();
    workerDb = await servicePool("notify", String(t.settings.database), 4);
  }, 120_000);

  afterAll(async () => {
    await workerDb.drop();
    await t.drop();
  }, 120_000);

  /** A recipient with one push contact, as papi.register_push stores it. */
  async function withPush(): Promise<{ ref: { type: "investor"; id: string }; recipient: string; contact: string }> {
    const ref = investor();
    const recipient = await new NotifyService(t.pool, t.secrets).registerRecipient(ref, "ur", "web");
    const { lookupHash, sealed } = sealer.seal(recipient, TOKEN);
    const { rows } = await t.pool.query<{ id: string }>(
      "INSERT INTO notify.contacts (recipient_id, channel, lookup_hash, sealed, key_version, registered_by) VALUES ($1, 'push', $2, $3, 1, 'papi') RETURNING id::text",
      [recipient, lookupHash, sealed],
    );
    return { ref, recipient, contact: rows[0]?.id ?? "" };
  }

  const worker = (push: MockProvider | { name: string; channel: "push"; send: () => Promise<never>; lookup: () => Promise<{ state: "unknown" }> }): NotifyWorker =>
    new NotifyWorker(workerDb.pool, { workerId: `w-${randomUUID().slice(0, 8)}`, providers: { push }, secrets: t.secrets, push: opener, leaseSeconds: 30, sendTimeoutMs: 5_000 });

  it("opens the token in the worker and sends the push template; a gone token is superseded", async () => {
    const a = await withPush();
    await enqueue(t.pool, { key: `push:${randomUUID()}`, event: { kind: "security.account_frozen", params: { at: "2026-11-06T09:00:00Z" } }, recipient: a.ref, actor: "test" });
    const mock = new MockProvider("push");
    expect(await worker(mock).runOnce()).toBe(1);
    expect(mock.sent).toHaveLength(1);
    expect(mock.sent[0]?.to).toBe(TOKEN);
    expect(mock.sent[0]?.locale).toBe("ur");

    await t.pool.query("UPDATE notify.contacts SET superseded_at = now() WHERE id = $1", [a.contact]); // the same token moves to b
    const b = await withPush();
    await enqueue(t.pool, { key: `push:${randomUUID()}`, event: { kind: "security.account_frozen", params: { at: "2026-11-06T09:00:00Z" } }, recipient: b.ref, actor: "test" });
    const gone = { name: "fcm", channel: "push" as const, send: () => Promise.reject(new PushTokenGone("gone")), lookup: () => Promise.resolve({ state: "unknown" as const }) };
    expect(await worker(gone).runOnce()).toBe(1);
    const c = await t.pool.query<{ superseded: boolean }>("SELECT superseded_at IS NOT NULL AS superseded FROM notify.contacts WHERE id = $1", [b.contact]);
    expect(c.rows[0]?.superseded).toBe(true);
    const d = await t.pool.query<{ status: string }>("SELECT status FROM notify.deliveries WHERE contact_id = $1", [b.contact]);
    expect(d.rows.map((r) => r.status)).toEqual(["dead"]);
  });
});
