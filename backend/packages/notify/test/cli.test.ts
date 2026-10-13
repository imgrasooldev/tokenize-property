import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvFile } from "@pt/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContactSecrets } from "../src/crypto.ts";
import { enqueue, NotifyService } from "../src/service.ts";
import { contacts, investor, makeNotifyDb, type NotifyDb } from "./helpers.ts";

/** Smoke test of the operator CLI (npm run notify:*) against a scratch database and a temporary env file. */

const TSX = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
let t: NotifyDb;
let dir: string;
let envFile: string;

beforeAll(async () => {
  t = await makeNotifyDb();
  dir = mkdtempSync(join(tmpdir(), "pt-notify-cli-"));
  envFile = join(dir, "env.local");
}, 120_000);

afterAll(async () => {
  await t.drop();
  rmSync(dir, { recursive: true, force: true });
}, 120_000);

function cli(...args: string[]): { code: number | null; out: string; err: string } {
  const s = t.settings;
  const r = spawnSync(process.execPath, [TSX, CLI, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      NODE_ENV: "test",
      NOTIFY_ENV_FILE: envFile,
      PG_HOST: String(s.host),
      PG_PORT: String(s.port),
      PG_ADMIN_USER: String(s.user),
      PG_ADMIN_PASSWORD: String(s.password),
      PG_DATABASE: String(s.database),
    },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("notify CLI", () => {
  it("creates the keys once without printing them, runs the worker once and reports status", async () => {
    const first = cli("setup");
    expect(first.code, first.err).toBe(0);
    expect(first.out).toMatch(/added 2 notify key\(s\)/);
    const keys = readEnvFile(envFile);
    expect(keys.NOTIFY_DATA_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.NOTIFY_LOOKUP_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(first.out + first.err).not.toContain(keys.NOTIFY_DATA_KEY ?? "x");
    expect(first.out + first.err).not.toContain(keys.NOTIFY_LOOKUP_KEY ?? "x");
    // Created once: a second run never replaces a key (sealed contacts would stop opening).
    const before = readFileSync(envFile, "utf8");
    expect(cli("setup").out).toMatch(/already present/);
    expect(readFileSync(envFile, "utf8")).toBe(before);

    const empty = cli("status");
    expect(empty.code, empty.err).toBe(0);
    expect(empty.out).toMatch(/notify audit chain intact/);

    // Contacts sealed with the keys setup created; the worker opens them in its own process.
    const secrets = ContactSecrets.fromEnv(keys);
    const svc = new NotifyService(t.pool, secrets);
    const ref = investor();
    const id = await svc.registerRecipient(ref, "en", "web");
    const c = contacts();
    await svc.registerContact(id, "sms", c.phone, "web");
    await svc.registerContact(id, "email", c.email, "web");
    await enqueue(t.pool, { key: `cli:${ref.id}`, event: { kind: "security.new_device_sign_in", params: { device: "Chrome on Windows", at: "2026-10-13T09:00:00Z" } }, recipient: ref, actor: "web" });

    const run = cli("run", "--once");
    expect(run.code, run.err).toBe(0);
    expect(run.out).toMatch(/handled 2 deliveries/);
    expect(run.out.match(/\[mock\] accepted/g)).toHaveLength(2);
    // The worker's output never shows the contact or the message.
    expect(run.out + run.err).not.toContain(c.phone.slice(1));
    expect(run.out + run.err).not.toContain(c.email);
    expect(run.out).not.toContain("Chrome on Windows");

    // An investor with no contact on file: the security notice is undeliverable and status exits 3.
    await enqueue(t.pool, { key: `cli:none:${ref.id}`, event: { kind: "security.account_frozen", params: { at: "2026-10-13T09:00:00Z" } }, recipient: investor(), actor: "kyc" });
    const status = cli("status");
    expect(status.code).toBe(3);
    expect(status.out).toMatch(/^sent\s+2 /m);
    expect(status.out).toMatch(/undeliverable #\d+ security\.account_frozen investor:/);
    expect(status.out).toMatch(/0 dead letter\(s\), 1 undeliverable security notice\(s\)/);

    expect(cli("nonsense").code).toBe(2);
  }, 180_000);

  it("refuses setup and the mock worker in production", () => {
    const r = spawnSync(process.execPath, [TSX, CLI, "setup"], { encoding: "utf8", timeout: 60_000, env: { ...process.env, NODE_ENV: "production", NOTIFY_ENV_FILE: envFile } });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/local development only/);
    const w = spawnSync(process.execPath, [TSX, CLI, "run", "--once"], { encoding: "utf8", timeout: 60_000, env: { ...process.env, NODE_ENV: "production" } });
    expect(w.status).toBe(1);
    expect(w.stderr).toMatch(/mock providers/);
  }, 120_000);
});
