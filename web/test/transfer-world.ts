import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type pg from "pg";

/**
 * A scratch database for the website's transfer screen (S-04 phase 0, migration 0028), mirroring
 * the backend's own test world in backend/packages/transfer/test/transfer.test.ts: the bank world
 * (KYC service, mock bank, all migrations), a real indexer on a fake chain (identities, countries,
 * token balances in the read model), the transfer.* signing policies, the token's completed
 * offering (lock-up, limits) and PT Control officers acting through admin.* with real sessions and
 * digests. The backend's helpers are imported dynamically from backend/ (never modified).
 * TEST ONLY: the offering row is written directly with triggers off, as the backend test does.
 */

const BACKEND = join(import.meta.dirname, "..", "..", "backend");
const backendFile = async <T>(...p: string[]): Promise<T> => (await import(/* @vite-ignore */ pathToFileURL(join(BACKEND, "packages", ...p)).href)) as T;

export const PRICE = 100_000n; // paisa per unit (PKR 1,000)
const ZERO = "0x0000000000000000000000000000000000000000";

interface BankWorld {
  db: pg.Client;
  pool: pg.Pool;
  settings: pg.ClientConfig;
  kyc: { onboard(i: { cnic: string; fullName: string; livenessSessionId: string; wallet?: string }): Promise<{ subjectId: string; status: string }> };
  bank: { registerPayee(subjectId: string, iban: string): Promise<unknown> };
  mock: { receiveRaast(i: { payerIban: string; amountPaisa: bigint; narration: string }): Promise<{ raastRef: string }> };
  drop(): Promise<void>;
}
interface Deployment {
  contracts: Record<string, string | undefined>;
}
type FakeEvent = { role: string; name: string; args: Record<string, unknown> };
interface FakeChainT {
  mine(d: Deployment, events: FakeEvent[]): unknown;
}
interface IndexerT {
  register(): Promise<void>;
  catchUp(): Promise<unknown>;
}

export interface Person {
  subjectId: string;
  wallet: string;
  iban: string;
  name: string;
  investorId: string;
}

export interface TransferWorld {
  w: BankWorld;
  db: pg.Client;
  token: string;
  database: string;
  person(units?: bigint): Promise<Person>;
  /** The buyer pays by Raast from their registered account with the payment code (mock bank). */
  pay(p: Person, code: string, amount: bigint): Promise<void>;
  tick(): Promise<number>;
  act(who: "desk" | "compliance" | "trustee", caseUuid: string, action: string, capacity?: string | null): Promise<{ ok: boolean; status?: string; error?: string }>;
  caseStatus(caseUuid: string): Promise<string>;
  drop(): Promise<void>;
}

/** Runs where the backend is installed and its PostgreSQL is reachable with the website's role set up; skipped otherwise. */
export async function databaseReady(): Promise<boolean> {
  const envFile = join(BACKEND, ".env.local");
  if (!existsSync(join(BACKEND, "node_modules", "@pt", "bank")) || !existsSync(join(BACKEND, "packages", "transfer")) || !existsSync(envFile)) return false;
  const env = readFileSync(envFile, "utf8");
  if (!/^WEB_PG_USER=/m.test(env) || !/^WEB_PG_PASSWORD=/m.test(env)) return false;
  const port = Number(/^PG_PORT=(\d+)/m.exec(env)?.[1] ?? 5433);
  return new Promise((resolve) => {
    const s = connect({ host: "127.0.0.1", port }, () => {
      s.end();
      resolve(true);
    });
    s.on("error", () => {
      resolve(false);
    });
    s.setTimeout(2_000, () => {
      s.destroy();
      resolve(false);
    });
  });
}

const OFFICERS = {
  desk: ["webxfer.desk", "ops_maker"],
  compliance: ["webxfer.compliance", "compliance_officer"],
  trustee: ["webxfer.trustee", "trustee_officer"],
} as const;

export async function makeTransferWorld(): Promise<TransferWorld> {
  const bankSetup = await backendFile<{
    world(): Promise<BankWorld>;
    newAccount(w: BankWorld, title: string): string;
    ageCoolingOff(w: BankWorld, subjectId: string): Promise<void>;
  }>("bank", "test", "setup.ts");
  const officers = await backendFile<{ officer(db: pg.ClientBase, handle: string, role: string): Promise<{ sessionHash: Buffer }> }>("db", "test", "officers.ts");
  const indexerMod = await backendFile<{ Indexer: new (pool: pg.Pool, chain: FakeChainT, d: Deployment) => IndexerT }>("indexer", "src", "index.ts");
  const fakeChain = await backendFile<{ FakeChain: new () => FakeChainT; fakeDeployment(fromBlock: bigint): Deployment }>("indexer", "test", "fake-chain.ts");

  const w = await bankSetup.world();
  const db = w.db;
  try {
    const chain = new fakeChain.FakeChain();
    const d = fakeChain.fakeDeployment(1n);
    const indexer = new indexerMod.Indexer(w.pool, chain, d);
    await indexer.register();
    await indexer.catchUp();
    const lc = (a: string | undefined) => (a ?? "").toLowerCase();
    const token = lc(d.contracts.token);
    const rule = { chainId: 586586, keyRef: "trustee", recoveryGuard: lc(d.contracts.recovery), token, identityRegistry: lc(d.contracts.identityRegistry), maxBalance: "100000", maxPerDay: 200, approvals: 0 };
    await db.query("INSERT INTO signer.keys (key_ref, address, purpose) VALUES ('trustee', $1, 'test')", [`0x${randomBytes(20).toString("hex")}`]);
    for (const kind of ["transfer.propose", "transfer.execute", "transfer.cancel"]) {
      const { rows } = await db.query<{ id: string }>("SELECT signer.propose_policy($1, $2::jsonb, 'maker') AS id", [kind, JSON.stringify(rule)]);
      await db.query("SELECT signer.approve_policy($1, 'checker')", [rows[0]?.id]);
    }
    // The token's completed offering (lock-up end, holding limits, offering price): TEST ONLY, as in the backend test.
    await db.query("SET session_replication_role = replica");
    await db.query(
      `INSERT INTO offering.offerings (property_id, state, price_paisa, min_units, max_units, max_holding_units, register_units, token, completed_at, created_by)
       VALUES (gen_random_uuid(), 'completed', $1, 10, 100000, 100000, 1000000, $2, now() - interval '7 months', 'test-setup')`,
      [PRICE.toString(), token],
    );
    await db.query("RESET session_replication_role");

    let seq = Math.floor(Math.random() * 1000) * 10;
    const mine = async (events: FakeEvent[]) => {
      chain.mine(d, events);
      await indexer.catchUp();
    };

    const person = async (units = 0n): Promise<Person> => {
      const letters = "abcdefghij";
      const name = `Webxfer ${String(++seq)
        .split("")
        .map((c) => letters.charAt(Number(c)))
        .join("")} Person`;
      const wallet = `0x${randomBytes(20).toString("hex")}`;
      const cnic = `4220${String(10_000_000 + seq).slice(-8)}${String(1 + (seq % 7))}`;
      const r = await w.kyc.onboard({ cnic, fullName: name, livenessSessionId: `sess-webxfer-${String(seq)}`, wallet });
      if (r.status !== "verified") throw new Error(`test investor not verified (${r.status})`);
      const events: FakeEvent[] = [
        { role: "identityRegistry", name: "IdentityRegistered", args: { investorAddress: wallet, identity: `0x${randomBytes(20).toString("hex")}` } },
        { role: "identityRegistry", name: "CountryUpdated", args: { investorAddress: wallet, country: 586 } },
      ];
      if (units > 0n) events.push({ role: "token", name: "Transfer", args: { from: ZERO, to: wallet, value: units } });
      await mine(events);
      if (units > 0n) await db.query("SELECT trustee.enter($1, $2, $3, 'offering', $4, 'test-setup')", [token, wallet, units.toString(), `test:${wallet}`]);
      const iban = bankSetup.newAccount(w, name);
      await w.bank.registerPayee(r.subjectId, iban);
      await bankSetup.ageCoolingOff(w, r.subjectId);
      const inv = await db.query<{ id: string }>(
        "INSERT INTO webdemo.investors (display_name, wallet_address, kyc_status, kyc_subject, onboard_step) VALUES ($1, $2, 'verified', $3, 'done') RETURNING id",
        [name, wallet, r.subjectId],
      );
      return { subjectId: r.subjectId, wallet, iban, name, investorId: inv.rows[0]?.id ?? "" };
    };

    const caseId = async (uuid: string): Promise<string> => {
      const { rows } = await db.query<{ id: string }>("SELECT id FROM transfer.cases WHERE case_uuid = $1", [uuid]);
      if (!rows[0]) throw new Error(`no case ${uuid}`);
      return rows[0].id;
    };

    const act: TransferWorld["act"] = async (who, caseUuid, action, capacity = null) => {
      const [handle, role] = new Map<string, readonly [string, string]>(Object.entries(OFFICERS)).get(who) ?? ["", ""];
      const session = (await officers.officer(db, handle, role)).sessionHash;
      const id = await caseId(caseUuid);
      const v = await db.query<{ v: { digest: string } | null }>("SELECT admin.transfer_case($1, $2) AS v", [session, id]);
      const digest = v.rows[0]?.v?.digest ?? "";
      const { rows } = await db.query<{ r: { ok: boolean; status?: string; error?: string } }>("SELECT admin.transfer_act($1, $2, $3, $4, $5, $6) AS r", [
        session,
        id,
        action,
        capacity,
        "checked the file against the records",
        Buffer.from(digest, "hex"),
      ]);
      return rows[0]?.r ?? { ok: false };
    };

    return {
      w,
      db,
      token,
      database: w.settings.database ?? "",
      person,
      pay: async (p, code, amount) => {
        await w.mock.receiveRaast({ payerIban: p.iban, amountPaisa: amount, narration: `Transfer ${code}` });
      },
      tick: async () => (await db.query<{ n: number }>("SELECT transfer.tick('transfer-worker') AS n")).rows[0]?.n ?? 0,
      act,
      caseStatus: async (uuid) => (await db.query<{ status: string }>("SELECT status FROM transfer.cases WHERE case_uuid = $1", [uuid])).rows[0]?.status ?? "",
      drop: () => w.drop(),
    };
  } catch (e) {
    await w.drop();
    throw e;
  }
}
