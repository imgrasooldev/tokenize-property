import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stateAnchorAbi } from "@pt/contracts";
import type { KeyProvider } from "@pt/signer";
import type pg from "pg";
import type { Address, Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Anchorer, type AnchorerOptions, type CrashPoint } from "../src/anchorer.ts";
import { rpcAnchorChain, rpcBesu, type BesuSource } from "../src/chains.ts";
import { anchorDeploymentFromBroadcast } from "../src/deployment.ts";
import { ANCHOR_KEY_REF, createDevAnchorKey, openDevAnchorKeys } from "../src/keys.ts";
import { LOCAL_ANCHOR_CHAIN_ID } from "../src/network.ts";
import { anchorsOf } from "../src/store.ts";
import { verifyAnchors } from "../src/verify.ts";
import { FakeBesu } from "./fakes.ts";
import { migratedDatabase, postJournals, rehashLedgerAfterEdit } from "./helpers.ts";

/**
 * Integration on a REAL local Anvil chain (started here on a free port, chain ID 586650) with the
 * contract deployed through DeployLib (forge script DeployAnchor.s.sol, Anvil's unlocked accounts) and
 * the anchor key in a real encrypted keystore. Part 1 uses a fake private chain; part 2 the local Besu
 * network, read-only. Skipped when Foundry, the contract build or Besu is not available.
 */
const CONTRACTS = fileURLToPath(new URL("../../../../contracts/", import.meta.url));
const exe = (tool: string): string | null => {
  const local = join(homedir(), ".foundry", "bin", process.platform === "win32" ? `${tool}.exe` : tool);
  if (existsSync(local)) return local;
  return spawnSync(tool, ["--version"]).status === 0 ? tool : null;
};
const ANVIL = exe("anvil");
const FORGE = exe("forge");
const available = ANVIL !== null && FORGE !== null && existsSync(join(CONTRACTS, "out", "StateAnchor.sol", "StateAnchor.json"));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => {
        resolve(typeof a === "object" && a ? a.port : 0);
      });
    });
  });
}

async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await r.json()) as { result?: T; error?: unknown };
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result as T;
}

interface Stand {
  url: string;
  proc: ChildProcess;
  keys: KeyProvider;
  anchorer: Address;
}

async function startAnvil(): Promise<Stand> {
  const port = await freePort();
  const url = `http://127.0.0.1:${String(port)}`;
  const proc = spawn(ANVIL ?? "anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(LOCAL_ANCHOR_CHAIN_ID), "--quiet"], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await rpc<string>(url, "eth_chainId")) === `0x${LOCAL_ANCHOR_CHAIN_ID.toString(16)}`) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "pt-anchor-ks-"));
  const passphrase = randomBytes(32).toString("base64url");
  const anchorer = await createDevAnchorKey(dir, passphrase);
  const keys = await openDevAnchorKeys(dir, passphrase);
  await rpc(url, "anvil_setBalance", [anchorer, `0x${(10n ** 19n).toString(16)}`]);
  return { url, proc, keys, anchorer };
}

/** Deploys StateAnchor through DeployLib exactly like `python chain/anchor.py deploy`, into a private broadcast folder. */
function deploy(s: Stand): { contract: Address; fromBlock: bigint; ms: number } {
  const t0 = performance.now();
  const broadcast = mkdtempSync(join(tmpdir(), "pt-anchor-bc-"));
  const deployer = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"; // Anvil account 0 (unlocked; no key used here)
  const owner = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"; // Anvil account 1 stands in for the Safe
  const r = spawnSync(FORGE ?? "forge", ["script", "script/DeployAnchor.s.sol", "--rpc-url", s.url, "--broadcast", "--unlocked", "--sender", deployer], {
    cwd: CONTRACTS,
    env: { ...process.env, DEPLOYER: deployer, ANCHOR_OWNER: owner, ANCHORER: s.anchorer, LOCAL_DEV_NETWORK: "true", FOUNDRY_BROADCAST: broadcast },
    encoding: "utf8",
    timeout: 240_000,
  });
  if (r.status !== 0 || !r.stdout.includes("ONCHAIN EXECUTION COMPLETE & SUCCESSFUL")) throw new Error(`deploy failed: ${r.stdout.slice(-1500)}${r.stderr.slice(-1500)}`);
  const d = anchorDeploymentFromBroadcast(join(broadcast, "DeployAnchor.s.sol", String(LOCAL_ANCHOR_CHAIN_ID), "run-latest.json"), LOCAL_ANCHOR_CHAIN_ID);
  if (!d) throw new Error("no deployment in the broadcast");
  return { contract: d.contract, fromBlock: d.fromBlock, ms: Math.round(performance.now() - t0) };
}

function job(pool: pg.Pool, s: Stand, contract: Address, besu: BesuSource, besuChainId: number, extra: Partial<AnchorerOptions> = {}): Anchorer {
  return new Anchorer(pool, rpcAnchorChain(s.url), besu, {
    target: { anchorChainId: LOCAL_ANCHOR_CHAIN_ID, contract },
    besuChainId,
    keys: s.keys,
    keyRef: ANCHOR_KEY_REF,
    custody: "dev-file",
    actor: "anvil-test",
    receiptWaitMs: 10_000,
    ...extra,
  });
}

const crashAt = (point: CrashPoint): AnchorerOptions["hooks"] => ({
  at: (p) => {
    if (p === point) throw new Error(`crash at ${p}`);
  },
});

describe.skipIf(!available)("anchoring on a real local Anvil chain", () => {
  let stand: Stand;
  let db: Awaited<ReturnType<typeof migratedDatabase>>;
  let contract: Address;
  let fromBlock: bigint;
  const besu = new FakeBesu();

  beforeAll(async () => {
    stand = await startAnvil();
    db = await migratedDatabase();
    const d = deploy(stand);
    ({ contract, fromBlock } = d);
    process.stdout.write(`[anchor] DeployLib deploy via forge script: ${String(d.ms)} ms\n`);
  }, 300_000);

  afterAll(async () => {
    stand.proc.kill();
    await db.drop();
  });

  it("deploys through DeployLib with the configured owner and anchor key", async () => {
    const chain = rpcAnchorChain(stand.url);
    expect(await chain.anchorer(contract)).toBe(stand.anchorer.toLowerCase());
    expect(await chain.client.readContract({ address: contract, abi: stateAnchorAbi, functionName: "owner" })).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    expect(await chain.lastAnchoredBlock(contract)).toBe(0n);
  });

  it("anchors, recovers from a crash after recording the signed transaction, verifies and detects a re-hashed ledger", async () => {
    await postJournals(db.pool, 3);
    const t0 = performance.now();
    const first = await job(db.pool, stand, contract, besu, besu.id).runOnce();
    const firstMs = performance.now() - t0;
    expect(first).toMatchObject({ action: "anchored", besuBlock: 100n });

    besu.height = 150n;
    await postJournals(db.pool, 2);
    await expect(job(db.pool, stand, contract, besu, besu.id, { hooks: crashAt("sent-recorded") }).runOnce()).rejects.toThrow(/crash/);
    const [, open] = await anchorsOf(db.pool, { anchorChainId: LOCAL_ANCHOR_CHAIN_ID, contract });
    expect(open?.status).toBe("sent");
    const second = await job(db.pool, stand, contract, besu, besu.id).runOnce();
    expect(second).toMatchObject({ action: "anchored", besuBlock: 150n, txHash: open?.tx?.hash }); // the SAME signed transaction

    const chain = rpcAnchorChain(stand.url);
    expect(await chain.lastAnchoredBlock(contract)).toBe(150n);
    const v0 = performance.now();
    const report = await verifyAnchors(db.pool, chain, besu, { target: { anchorChainId: LOCAL_ANCHOR_CHAIN_ID, contract }, besuChainId: besu.id, fromBlock, logWindow: 2n });
    const verifyMs = performance.now() - v0;
    expect(report).toMatchObject({ ok: true, anchors: 2, records: 2 });
    process.stdout.write(`[anchor] Anvil: first anchor ${firstMs.toFixed(0)} ms, recovery anchor ${String(second.ms)} ms, verify ${verifyMs.toFixed(0)} ms (${String(report.scanned.windows)} log windows)\n`);

    await rehashLedgerAfterEdit(db.admin, 1n, "rewritten by a rogue DBA");
    const after = await verifyAnchors(db.pool, chain, besu, { target: { anchorChainId: LOCAL_ANCHOR_CHAIN_ID, contract }, besuChainId: besu.id, fromBlock });
    expect(after.ok).toBe(false);
    expect(after.problems.filter((p) => p.includes("LEDGER CHANGED"))).toHaveLength(2);
  }, 120_000);
});

const BESU_RPC = process.env.CHAIN_RPC_URL ?? "http://127.0.0.1:8545";
async function besuUp(): Promise<boolean> {
  try {
    return (await rpcBesu(BESU_RPC, 3_000).chainId()) === 586_586;
  } catch {
    return false;
  }
}
const besuLive = available && (await besuUp());

describe.skipIf(!besuLive)("anchoring the local Besu network (read-only on Besu) to a real Anvil chain", () => {
  let stand: Stand;
  let db: Awaited<ReturnType<typeof migratedDatabase>>;

  beforeAll(async () => {
    stand = await startAnvil();
    db = await migratedDatabase();
  }, 300_000);

  afterAll(async () => {
    stand.proc.kill();
    await db.drop();
  });

  it("anchors a real finalized Besu block and verifies its hash against the Besu node", async () => {
    const { contract, fromBlock } = deploy(stand);
    await postJournals(db.pool, 2);
    const besu = rpcBesu(BESU_RPC);
    const r = await job(db.pool, stand, contract, besu, 586_586, { besuConfirmations: 1n }).runOnce();
    expect(r.action).toBe("anchored");
    const anchored = r.action === "anchored" ? r.besuBlock : 0n;
    const block = await rpc<{ hash: Hex }>(BESU_RPC, "eth_getBlockByNumber", [`0x${anchored.toString(16)}`, false]);
    const [rec] = await anchorsOf(db.pool, { anchorChainId: LOCAL_ANCHOR_CHAIN_ID, contract });
    expect(rec?.besuBlockHash).toBe(block.hash.toLowerCase());
    const report = await verifyAnchors(db.pool, rpcAnchorChain(stand.url), besu, { target: { anchorChainId: LOCAL_ANCHOR_CHAIN_ID, contract }, besuChainId: 586_586, fromBlock });
    expect(report.problems).toEqual([]);
    process.stdout.write(`[anchor] Besu block ${anchored.toString()} anchored on Anvil in ${String(r.ms)} ms; verify ${String(report.ms)} ms\n`);
  }, 300_000);
});
