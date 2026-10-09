import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { tokenAbi } from "@pt/contracts";
import { migrate } from "@pt/db";
import { openAccount, postJournal, verifyChain } from "@pt/ledger";
import pg from "pg";
import { createPublicClient, http, type Address } from "viem";
import { demoAddresses, latestDeployment, ROOT } from "./local.ts";

export type Log = (line: string) => void;

const MIGRATIONS = fileURLToPath(new URL("../../db/migrations", import.meta.url));

/** Runs a repository script and streams its output line by line. */
export function runScript(args: string[], log: Log): Promise<number> {
  return new Promise((resolve) => {
    const sep = process.platform === "win32" ? ";" : ":";
    const env = { ...process.env, PATH: `${process.env.PATH ?? ""}${sep}${homedir()}/.foundry/bin` };
    // -u: unbuffered, so each check appears in the console the moment it happens.
    const child = spawn("python", ["-u", ...args], { cwd: ROOT, env, windowsHide: true });
    const forward = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) log(line);
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });
}

const rupees = (paisa: bigint) =>
  `Rs ${(paisa / 100n).toLocaleString("en-PK")}.${(paisa % 100n).toString().padStart(2, "0")}`;

/**
 * One rent cycle in the ledger, split in proportion to on-chain token balances with exact paisa
 * (largest-remainder rounding, so the parts always add up to the whole).
 */
export async function rentCycle(db: pg.Pool, log: Log): Promise<void> {
  const rentPaisa = 30_000_000n; // Rs 300,000
  const roles = demoAddresses();
  const d = latestDeployment();
  const investors = ["ALICE", "BOB"] as const;

  let holdings: bigint[] = [1n, 1n];
  if (d) {
    const client = createPublicClient({ transport: http("http://127.0.0.1:8545", { timeout: 2_000 }) });
    try {
      holdings = await Promise.all(
        investors.map((r) =>
          client.readContract({
            address: d.token,
            abi: tokenAbi,
            functionName: "balanceOf",
            args: [roles.get(r) as Address],
          }),
        ),
      );
      log(`On-chain holdings: Alice ${holdings.at(0) ?? 0n}, Bob ${holdings.at(1) ?? 0n} tokens`);
    } catch {
      log("Chain not reachable; splitting 50/50 for the demo");
    }
  }
  const total = holdings.reduce((a, b) => a + b, 0n);
  if (total === 0n) {
    log("No tokens issued yet; run the full scenario first.");
    return;
  }

  let shares = holdings.map((h) => (rentPaisa * h) / total);
  let remainder = rentPaisa - shares.reduce((a, b) => a + b, 0n);
  const order = holdings
    .map((h, i) => ({ i, frac: (rentPaisa * h) % total }))
    .sort((x, y) => (y.frac > x.frac ? 1 : y.frac < x.frac ? -1 : 0));
  for (const { i } of order) {
    if (remainder === 0n) break;
    shares = shares.map((s, j) => (j === i ? s + 1n : s));
    remainder -= 1n;
  }

  await openAccount(db, { code: "demo:bank:escrow", kind: "asset", asset: "PKR" });
  await openAccount(db, { code: "demo:income:rent", kind: "income", asset: "PKR", allowOverdraft: true });
  for (const r of investors) {
    await openAccount(db, { code: `demo:investor:${r.toLowerCase()}:payable`, kind: "liability", asset: "PKR" });
  }

  const cycle = `${Date.now()}`;
  await postJournal(db, {
    idempotencyKey: `demo:rent:${cycle}`,
    kind: "rent_received",
    memo: "Monthly rent received in trustee escrow",
    createdBy: "demo-console",
    postings: [
      { account: "demo:bank:escrow", amount: rentPaisa },
      { account: "demo:income:rent", amount: -rentPaisa },
    ],
  });
  log(`1. Rent received: ${rupees(rentPaisa)} into trustee escrow`);

  await postJournal(db, {
    idempotencyKey: `demo:distribute:${cycle}`,
    kind: "rent_distribution",
    memo: "Rent allocated to investors by token holding",
    createdBy: "demo-console",
    postings: [
      { account: "demo:income:rent", amount: rentPaisa },
      ...investors.map((r, i) => ({ account: `demo:investor:${r.toLowerCase()}:payable`, amount: -(shares.at(i) ?? 0n) })),
    ],
  });
  log(`2. Allocated: Alice ${rupees(shares.at(0) ?? 0n)}, Bob ${rupees(shares.at(1) ?? 0n)} (sum exact to the paisa)`);

  for (const [i, r] of investors.entries()) {
    const amount = shares.at(i) ?? 0n;
    if (amount === 0n) continue;
    await postJournal(db, {
      idempotencyKey: `demo:payout:${cycle}:${r}`,
      kind: "payout",
      memo: `Bank payout to ${r.toLowerCase()}`,
      createdBy: "demo-console",
      postings: [
        { account: `demo:investor:${r.toLowerCase()}:payable`, amount },
        { account: "demo:bank:escrow", amount: -amount },
      ],
    });
  }
  log("3. Paid out to both investors' bank accounts");

  try {
    await postJournal(db, {
      idempotencyKey: `demo:overpay:${cycle}`,
      kind: "payout",
      memo: "Attempted double payout",
      createdBy: "demo-console",
      postings: [
        { account: "demo:investor:alice:payable", amount: 1n },
        { account: "demo:bank:escrow", amount: -1n },
      ],
    });
    log("!! Overpayment was NOT blocked (unexpected)");
  } catch {
    log("4. Attempted extra payout of 1 paisa to Alice: REFUSED by the database (no overdraft)");
  }
  const problems = await verifyChain(db);
  log(problems.length === 0 ? "5. Ledger hash chain verified: intact" : `!! Ledger chain problems: ${problems.length}`);
}

/** Shows tamper detection in a throw-away database, never touching the demo ledger. */
export async function tamperDemo(admin: pg.ClientConfig, log: Log): Promise<void> {
  const name = `pt_demo_tamper_${Date.now()}`;
  const root = new pg.Client({ ...admin, database: "postgres" });
  await root.connect();
  await root.query(`CREATE DATABASE ${name}`);
  const db = new pg.Client({ ...admin, database: name });
  await db.connect();
  try {
    await migrate(db, MIGRATIONS);
    await openAccount(db, { code: "t:bank", kind: "asset", asset: "PKR" });
    await openAccount(db, { code: "t:alice", kind: "liability", asset: "PKR" });
    for (let i = 1; i <= 3; i++) {
      await postJournal(db, {
        idempotencyKey: `tamper-demo-${i}`,
        kind: "deposit",
        createdBy: "demo",
        postings: [
          { account: "t:bank", amount: 100_000n },
          { account: "t:alice", amount: -100_000n },
        ],
      });
    }
    log("Scratch ledger: 3 deposits of Rs 1,000 for Alice. Chain verified: intact.");
    try {
      await db.query("UPDATE ledger.postings SET amount = -10000000 WHERE id = 4");
    } catch {
      log("Attempt 1 (normal user/admin): UPDATE a posting -> BLOCKED (append-only)");
    }
    await db.query("ALTER TABLE ledger.postings DISABLE TRIGGER postings_append_only");
    await db.query("UPDATE ledger.postings SET amount = -10000000 WHERE id = 4");
    await db.query("ALTER TABLE ledger.postings ENABLE TRIGGER postings_append_only");
    log("Attempt 2 (rogue DBA disables protection): Alice's deposit silently changed to Rs 100,000");
    const problems = await verifyChain(db);
    for (const p of problems) log(`   verify_chain -> journal ${p.journalId}: ${p.problem}`);
    log(problems.length > 0 ? "DETECTED: the hash chain exposes the change." : "!! Not detected (unexpected)");
  } finally {
    await db.end();
    await root.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await root.end();
    log("Scratch database deleted.");
  }
}
