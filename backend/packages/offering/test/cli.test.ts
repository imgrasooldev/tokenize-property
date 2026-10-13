import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { scratchDatabase } from "../../db/test/helpers.ts";

/** Smoke test of the operator CLI (npm run offering:*) against a scratch database. */

const TSX = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const MIGRATIONS = fileURLToPath(new URL("../../db/migrations", import.meta.url));
let settings: pg.ClientConfig;
let drop: () => Promise<void>;

beforeAll(async () => {
  const s = await scratchDatabase();
  await migrate(s.client, MIGRATIONS);
  settings = s.settings;
  drop = s.drop;
}, 120_000);

afterAll(async () => {
  await drop();
}, 120_000);

function cli(...args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [TSX, CLI, ...args], {
    encoding: "utf8",
    timeout: 150_000,
    env: {
      ...process.env,
      PG_HOST: String(settings.host),
      PG_PORT: String(settings.port),
      PG_ADMIN_USER: String(settings.user),
      PG_ADMIN_PASSWORD: String(settings.password),
      PG_DATABASE: String(settings.database),
    },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const json = (s: string): { ok: boolean; result?: unknown; code?: string } => JSON.parse(s.trim().split("\n").pop() ?? "{}") as { ok: boolean };

describe("offering CLI", () => {
  // Each call starts a tsx process (seconds on a busy laptop): keep the number of calls small.
  it("lists actions, runs one, refuses with typed errors, shows, ticks and verifies the audit", () => {
    expect(cli("run", "actions").out).toMatch(/createOffering[\s\S]*reserve[\s\S]*startMinting/);
    const duty = cli("run", "requestDuty", JSON.stringify({ actor: "off-cli", duty: "offering", by: "adm-1", reason: "assigned to the pilot offering" }));
    expect(duty.code, duty.err).toBe(0);
    expect(json(duty.out).result).toMatch(/^[1-9][0-9]*$/);
    const refused = cli("run", "createOffering", JSON.stringify({ propertyId: "00000000-0000-4000-8000-000000000001", actor: "off-cli" }));
    expect(refused.code).toBe(4);
    expect(json(refused.err)).toMatchObject({ ok: false, code: "FORBIDDEN" }); // the duty is not approved yet
    expect(json(cli("run", "reserve", JSON.stringify({ offeringId: "nope" })).err)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(cli("show", "00000000-0000-4000-8000-000000000001").out).toMatch(/unknown offering/);
    const tick = cli("tick");
    expect(tick.code, tick.err).toBe(0);
    const audit = cli("audit");
    expect(audit.code).toBe(0);
    expect(audit.out).toMatch(/offering audit chain intact/);
  }, 600_000);
});
