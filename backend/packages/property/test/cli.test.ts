import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { scratchDatabase } from "../../db/test/helpers.ts";
import { officerForDuty } from "../../db/test/officers.ts";
import { contiguousMigrations } from "./helpers.ts";

/** Smoke test of the operator CLI (npm run property:*) against a scratch database. */

const TSX = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
let settings: pg.ClientConfig;
let drop: () => Promise<void>;
const secrets = {
  PROPERTY_PEPPER_V1: randomBytes(32).toString("hex"),
  PROPERTY_PEPPER_CURRENT: "1",
  PROPERTY_DATA_KEY: randomBytes(32).toString("hex"),
};

beforeAll(async () => {
  const s = await scratchDatabase();
  await migrate(s.client, contiguousMigrations());
  // Migration 0016 (A-7): the duty below needs an officer of the admin portal (operations maker).
  await officerForDuty(s.client, "onb-cli", "onboarding");
  settings = s.settings;
  drop = s.drop;
}, 120_000);

afterAll(async () => {
  await drop();
}, 120_000);

function cli(...args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [TSX, CLI, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      ...secrets,
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

describe("property CLI", () => {
  it("runs workflow actions, shows state, lists the queue and verifies the audit", () => {
    expect(cli("run", "actions").out).toMatch(/createSponsor[\s\S]*submitProperty[\s\S]*trusteeDecide/);
    const duty = cli("run", "requestDuty", JSON.stringify({ actor: "onb-cli", duty: "onboarding", by: "adm-1", reason: "assigned to the pilot file" }));
    expect(duty.code).toBe(0);
    const dutyId = json(duty.out).result as string;
    expect(cli("run", "decideDuty", JSON.stringify({ dutyId, by: "adm-2", approve: true, reason: "checked against HR" })).code).toBe(0);
    const created = cli("run", "createSponsor", JSON.stringify({ kind: "company", legalName: "Cli Test (Private) Limited", address: "1 Mall Road, Lahore", cuin: "0099887", actor: "onb-cli" }));
    expect(created.code, created.err).toBe(0);
    const sponsorId = json(created.out).result as string;
    expect(sponsorId).toMatch(/^[0-9a-f-]{36}$/);
    const shown = cli("show", "sponsor", sponsorId);
    expect(JSON.parse(shown.out)).toMatchObject({ sponsorId, kind: "company", state: "kyb_draft", cuinLast4: "9887" });
    expect(shown.out).not.toMatch(/Cli Test|Mall Road/);
    const refusedRun = cli("run", "submitKyb", JSON.stringify({ sponsorId, actor: "onb-cli", actingFor: 1 }));
    expect(refusedRun.code).toBe(4);
    expect(json(refusedRun.err)).toMatchObject({ ok: false, code: "FORBIDDEN" });
    const bad = cli("run", "submitKyb", JSON.stringify({ sponsorId: "not-a-uuid", actor: "onb-cli", actingFor: 1 }));
    expect(json(bad.err)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(json(cli("run", "noSuchAction", "{}").err)).toMatchObject({ code: "INVALID_INPUT" });
    expect(cli("queue").out).toMatch(/0 item\(s\)/);
    expect(cli("expire").out).toMatch(/0 KYB file\(s\) expired/);
    const audit = cli("audit");
    expect(audit.code).toBe(0);
    expect(audit.out).toMatch(/property audit chain intact/);
  }, 120_000);
});
