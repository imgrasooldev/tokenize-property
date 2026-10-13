import { fileURLToPath } from "node:url";
import { LOCAL_DEV_CHAIN_ID, readEnvFile } from "@pt/config";
import pg from "pg";
import { createPublicClient, http } from "viem";
import { bookRent, demoBankStatements, seedLocal, statementReader } from "./booking.ts";
import { demoAddresses, latestDeployment, ROOT } from "./local.ts";

/**
 * LOCAL / DEMO bookings for reconciliation (Step 5h, ADR 0010), run from backend/:
 *   npm run seed:local            book chain/flow.py's scenario mint as Alice's seed subscription (once)
 *   npm run rent:book             book rent collected (published) and distributed (finalized) per distribution
 *   npm run recon:demo-bank       import the demo bank's statements (website payment records) up to today
 * Refused unless the node is the local dev chain (586586) and outside production. PG_DATABASE selects
 * the database (default property_token).
 */
const BACKEND = fileURLToPath(new URL("../../../", import.meta.url));

function env(): Record<string, string | undefined> {
  return { ...readEnvFile(`${BACKEND}.env.local`), ...process.env };
}

async function main(): Promise<void> {
  const [cmd] = process.argv.slice(2);
  const e = env();
  if (e.NODE_ENV === "production") throw new Error("local/demo bookings are refused in production");
  const rpc = e.CHAIN_RPC_URL ?? "http://127.0.0.1:8545";
  const id = await createPublicClient({ transport: http(rpc, { timeout: 5_000 }) }).getChainId();
  if (id !== LOCAL_DEV_CHAIN_ID) throw new Error(`the node is chain ${String(id)}, not the local dev chain`);
  const d = latestDeployment();
  if (!d) throw new Error("no local deployment; run python chain/flow.py");
  const contracts = { token: d.token, issuance: d.issuance, distributions: d.distributions };
  const db = new pg.Pool({
    host: e.PG_HOST ?? "127.0.0.1",
    port: Number(e.PG_PORT ?? 5433),
    user: e.PG_ADMIN_USER ?? "pt_admin",
    password: e.PG_ADMIN_PASSWORD,
    database: e.PG_DATABASE ?? "property_token",
    application_name: "demo-bookings",
    max: 2,
  });
  try {
    if (cmd === "seed") {
      const alice = demoAddresses().get("ALICE");
      if (!alice) throw new Error("no ALICE address in chain/network/dev-accounts.env");
      process.stdout.write(`seed subscription: ${await seedLocal(db, { contracts, alice })}\n`);
    } else if (cmd === "rent") {
      const r = await bookRent(db, { contracts, statement: statementReader(`${ROOT}chain/data/rent`, d.token) });
      process.stdout.write(`rent collected booked: [${r.collected.join(", ")}] · distributions booked: [${r.distributed.join(", ")}]` +
        (r.missingStatement.length ? ` · finalized without a matching statement (not booked): [${r.missingStatement.join(", ")}]` : "") + "\n");
    } else if (cmd === "bank") {
      process.stdout.write(`imported ${String(await demoBankStatements(db, { actor: "recon:demo-bank" }))} demo bank statement(s)\n`);
    } else {
      process.stdout.write("commands: seed | rent | bank\n");
      process.exitCode = 2;
    }
  } finally {
    await db.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
