import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { contiguousMigrations, scratchDatabase } from "../../db/test/helpers.ts";
import { Peppers } from "../src/crypto.ts";
import { linkDemoPersonas } from "../src/personas.ts";
import { mockProviders } from "../src/providers.ts";
import { KycService, statusOf } from "../src/service.ts";

/**
 * Demo personas get a real KYC subject (mock providers, fictional CNICs): verified, their wallet
 * bound, linked to the website row; a second run changes nothing; a persona whose website row was
 * recreated finds its subject again by the wallet.
 */
let pool: pg.Pool;
let drop: () => Promise<void>;
let kyc: KycService;
const wallets = { ALICE: `0x${randomBytes(20).toString("hex")}`, BOB: `0x${randomBytes(20).toString("hex")}` };

beforeAll(async () => {
  const s = await scratchDatabase();
  drop = s.drop;
  await migrate(s.client, contiguousMigrations());
  pool = new pg.Pool({ ...s.settings, max: 4 });
  kyc = new KycService(pool, mockProviders(), Peppers.of([{ version: 1, key: randomBytes(32) }]), randomBytes(32));
  for (const [persona, wallet] of Object.entries(wallets)) {
    await pool.query("INSERT INTO webdemo.investors (persona, display_name, wallet_address, kyc_status) VALUES ($1, $2, $3, 'verified')", [persona, `${persona} (demo)`, wallet]);
  }
}, 180_000);

afterAll(async () => {
  await pool.end();
  await drop();
}, 180_000);

describe("demo personas' KYC subjects", () => {
  it("links a verified subject with the persona's wallet, once", async () => {
    const first = await linkDemoPersonas(pool, kyc);
    expect(first.map((l) => [l.persona, l.outcome])).toEqual([
      ["ALICE", "linked"],
      ["BOB", "linked"],
    ]);
    for (const l of first) {
      expect((await statusOf(pool, l.subjectId))?.status).toBe("verified");
      const w = await pool.query<{ wallet: string }>("SELECT wallet FROM kyc.wallets WHERE subject_id = $1", [l.subjectId]);
      expect(w.rows[0]?.wallet).toBe(wallets[l.persona as keyof typeof wallets]);
    }
    const again = await linkDemoPersonas(pool, kyc);
    expect(again.map((l) => l.outcome)).toEqual(["already linked", "already linked"]);
    expect(again.map((l) => l.subjectId)).toEqual(first.map((l) => l.subjectId));

    // The website row is recreated (e.g. a fresh webdemo): the subject is found again by the wallet.
    await pool.query("UPDATE webdemo.investors SET kyc_subject = NULL WHERE persona = 'BOB'");
    const relinked = await linkDemoPersonas(pool, kyc);
    expect(relinked.find((l) => l.persona === "BOB")).toMatchObject({ outcome: "linked", subjectId: first[1]?.subjectId });
    expect((await pool.query("SELECT * FROM kyc.verify_audit()")).rows).toEqual([]);
  });
});
