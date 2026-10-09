import {
  distributionRegistryAbi,
  freezeGuardAbi,
  identityRegistryAbi,
  issuanceGuardAbi,
  pauseGuardAbi,
  recoveryGuardAbi,
  registrarGuardAbi,
  timelockAbi,
  tokenAbi,
} from "@pt/contracts";
import type pg from "pg";
import { createPublicClient, http, parseEventLogs, type Abi, type Address, type PublicClient } from "viem";
import { demoAddresses, latestDeployment, RPC_PORTS, type Deployment } from "./local.ts";

const EVENTS_ABI = [
  ...tokenAbi,
  ...issuanceGuardAbi,
  ...pauseGuardAbi,
  ...freezeGuardAbi,
  ...recoveryGuardAbi,
  ...registrarGuardAbi,
  ...distributionRegistryAbi,
  ...timelockAbi,
  ...identityRegistryAbi,
] as Abi;

const HOLDERS = ["ALICE", "BOB", "ALICE_NEW_WALLET"] as const;

async function rpc(port: number, method: string): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
    signal: AbortSignal.timeout(800),
  });
  const body = (await res.json()) as { result?: unknown };
  return body.result;
}

export interface FeedItem {
  block: string;
  text: string;
  kind: "mint" | "transfer" | "pause" | "freeze" | "governance" | "identity" | "recovery" | "rent" | "other";
}

export class DemoState {
  private client: PublicClient;
  private feed: FeedItem[] = [];
  private scannedTo = 0n;
  private deploymentToken: Address | null = null;
  private names = new Map<string, string>();

  constructor(private readonly ledgerDb: pg.Pool | null) {
    this.client = createPublicClient({ transport: http("http://127.0.0.1:8545", { timeout: 2_000 }) });
  }

  private label(addr: string): string {
    const name = this.names.get(addr.toLowerCase());
    return name ?? `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  }

  private refreshNames(d: Deployment | null): void {
    this.names.clear();
    for (const [role, addr] of demoAddresses()) {
      this.names.set(addr.toLowerCase(), role.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()));
    }
    if (d) {
      const contracts: [string, Address][] = [
        ["Token", d.token], ["Identity Registry", d.ir], ["IssuanceGuard", d.issuance], ["PauseGuard", d.pauseGuard],
        ["FreezeGuard", d.freezeGuard], ["RecoveryGuard", d.recovery], ["RegistrarGuard", d.registrarGuard],
        ["DistributionRegistry", d.distributions], ["Timelock", d.timelock],
      ];
      for (const [n, a] of contracts) this.names.set(a.toLowerCase(), n);
    }
  }

  async validators() {
    return Promise.all(
      RPC_PORTS.map(async (port, i) => {
        try {
          const [height, peers] = await Promise.all([rpc(port, "eth_blockNumber"), rpc(port, "net_peerCount")]);
          return { node: `node${i + 1}`, up: true, height: Number(height), peers: Number(peers) };
        } catch {
          return { node: `node${i + 1}`, up: false, height: null, peers: null };
        }
      }),
    );
  }

  private async recentBlocks() {
    const latest = await this.client.getBlockNumber();
    const blocks = await Promise.all(
      Array.from({ length: 6 }, (_, i) => latest - BigInt(i))
        .filter((n) => n >= 0n)
        .map((n) => this.client.getBlock({ blockNumber: n })),
    );
    return blocks.map((b) => ({
      number: b.number.toString(),
      time: new Date(Number(b.timestamp) * 1000).toISOString(),
      txs: b.transactions.length,
    }));
  }

  private describe(eventName: string, raw: Record<string, unknown>): Omit<FeedItem, "block"> | null {
    const args = new Map(Object.entries(raw));
    const text = (x: unknown): string =>
      typeof x === "string" || typeof x === "bigint" || typeof x === "number" || typeof x === "boolean" ? String(x) : "";
    const v = (k: string) => text(args.get(k));
    const a = (k: string) => this.label(v(k));
    switch (eventName) {
      case "Transfer":
        if (/^0x0+$/.test(v("from"))) return { kind: "mint", text: `Minted ${v("value")} tokens to ${a("to")}` };
        if (/^0x0+$/.test(v("to"))) return { kind: "mint", text: `Burned ${v("value")} tokens from ${a("from")}` };
        return { kind: "transfer", text: `${a("from")} transferred ${v("value")} tokens to ${a("to")}` };
      case "Paused":
        return args.has("reason") ? { kind: "pause", text: `${a("by")} PAUSED trading: "${v("reason")}"` } : null;
      case "Unpaused":
        return args.has("by") ? { kind: "pause", text: `${a("by")} resumed trading` } : null;
      case "AddressFreezeSet":
        return { kind: "freeze", text: `${a("account")} ${args.get("frozen") === true ? "FROZEN" : "unfrozen"} (compliance case)` };
      case "TrusteeCapSet":
        return { kind: "governance", text: `Trustee cap set to ${v("current")} units (via 72h-style timelock)` };
      case "CallScheduled":
        return { kind: "governance", text: `Timelock: change scheduled, waits ${v("delay")}s before it can run` };
      case "CallExecuted":
        return { kind: "governance", text: "Timelock: scheduled change executed" };
      case "InvestorRegistered":
        return { kind: "identity", text: `${a("account")} passed KYC/AML and was registered` };
      case "RecoveryProposed":
        return { kind: "recovery", text: `Trustee proposed a recovery/forced transfer (48h delay)` };
      case "RecoveryCancelled":
        return { kind: "recovery", text: `Recovery request cancelled by ${a("by")}` };
      case "RecoveryExecuted":
        return { kind: "recovery", text: `Recovery request executed` };
      case "DistributionPublished":
        return { kind: "rent", text: `Rent distribution published: Rs ${(Number(v("totalPaisa")) / 100).toLocaleString("en-PK")} (Merkle root on-chain)` };
      default:
        return null;
    }
  }

  private async scanEvents(d: Deployment): Promise<void> {
    if (this.deploymentToken !== d.token) {
      this.feed = [];
      this.scannedTo = d.fromBlock > 0n ? d.fromBlock - 1n : 0n;
      this.deploymentToken = d.token;
    }
    const latest = await this.client.getBlockNumber();
    if (latest <= this.scannedTo) return;
    const fromBlock = this.scannedTo + 1n;
    const logs = await this.client.getLogs({
      address: [d.token, d.issuance, d.pauseGuard, d.freezeGuard, d.recovery, d.registrarGuard, d.distributions, d.timelock],
      fromBlock,
      toBlock: latest,
    });
    const decoded = parseEventLogs({ abi: EVENTS_ABI, logs, strict: false });
    for (const log of decoded) {
      const item = this.describe(log.eventName, log.args as Record<string, unknown>);
      if (item) this.feed.unshift({ block: log.blockNumber.toString(), ...item });
    }
    this.feed = this.feed.slice(0, 60);
    this.scannedTo = latest;
  }

  private async token(d: Deployment) {
    const read = <T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []) =>
      this.client.readContract({ address, abi, functionName, args }) as Promise<T>;
    const [name, symbol, supply, paused, cap] = await Promise.all([
      read<string>(d.token, tokenAbi as Abi, "name"),
      read<string>(d.token, tokenAbi as Abi, "symbol"),
      read<bigint>(d.token, tokenAbi as Abi, "totalSupply"),
      read<boolean>(d.token, tokenAbi as Abi, "paused"),
      read<bigint>(d.issuance, issuanceGuardAbi as Abi, "trusteeCap"),
    ]);
    const roles = demoAddresses();
    const holders = await Promise.all(
      HOLDERS.filter((h) => roles.has(h)).map(async (h) => {
        const addr = roles.get(h) as Address;
        const [balance, frozen, verified] = await Promise.all([
          read<bigint>(d.token, tokenAbi as Abi, "balanceOf", [addr]),
          read<boolean>(d.token, tokenAbi as Abi, "isFrozen", [addr]),
          read<boolean>(d.ir, identityRegistryAbi as Abi, "isVerified", [addr]),
        ]);
        return { name: this.label(addr), address: addr, balance: balance.toString(), frozen, verified };
      }),
    );
    return { address: d.token, name, symbol, supply: supply.toString(), cap: cap.toString(), paused, holders };
  }

  private async ledger() {
    if (!this.ledgerDb) return null;
    const db = this.ledgerDb;
    // One connection: run the queries one after another (pg does not multiplex a single client).
    const problems = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM ledger.verify_chain()");
    const head = await db.query<{ journal_id: string; hash: string }>("SELECT * FROM ledger.chain_head()");
    const count = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM ledger.journal");
    const balances = await db.query<{ code: string; asset: string; balance: string }>(
      "SELECT code, asset, balance::text FROM ledger.balances WHERE code LIKE 'demo:%' ORDER BY code",
    );
    const recent = await db.query<{ id: string; kind: string; memo: string | null; created_at: Date; hash: string }>(
      "SELECT id::text, kind, memo, created_at, encode(hash, 'hex') AS hash FROM ledger.journal ORDER BY id DESC LIMIT 6",
    );
    return {
      intact: problems.rows[0]?.n === "0",
      problems: Number(problems.rows[0]?.n ?? 0),
      journals: Number(count.rows[0]?.n ?? 0),
      head: head.rows[0] ? { id: head.rows[0].journal_id, hash: head.rows[0].hash } : null,
      balances: balances.rows,
      recent: recent.rows.map((r) => ({ id: r.id, kind: r.kind, memo: r.memo, at: r.created_at.toISOString(), hash: r.hash })),
    };
  }

  /** One snapshot for the page. Every part fails independently so a down node never blanks the screen. */
  async snapshot() {
    const d = latestDeployment();
    this.refreshNames(d);
    const validators = await this.validators();
    const chainUp = validators.some((v) => v.up);
    const settle = async <T>(p: () => Promise<T>): Promise<T | { error: string }> => {
      try {
        return await p();
      } catch (e) {
        return { error: (e as Error).message.split("\n")[0] ?? "error" };
      }
    };
    const [blocks, token, ledger] = await Promise.all([
      chainUp ? settle(() => this.recentBlocks()) : Promise.resolve(null),
      chainUp && d ? settle(() => this.token(d)) : Promise.resolve(null),
      settle(() => this.ledger()),
    ]);
    if (chainUp && d) await settle(() => this.scanEvents(d));
    return { at: new Date().toISOString(), validators, blocks, token, ledger, feed: this.feed };
  }
}
