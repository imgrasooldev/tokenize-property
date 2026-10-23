import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Hex } from "viem";
import { eventAbi } from "../src/decode.ts";
import { parseDeployment, type Address, type Deployment, type Role } from "../src/deployment.ts";
import type { ChainSource, Header, RawLog } from "../src/source.ts";

/** An event to put on the fake chain: arguments by ABI name (bigints for integers). */
export interface FakeEvent {
  role: Role;
  name: string;
  args: Record<string, unknown>;
  /** Transaction index inside the block; events with the same value share one transaction (default: one each). */
  tx?: number;
}

/** A log that matches no ABI (kept raw by the indexer). */
export interface FakeRawEvent {
  role: Role;
  raw: { topics: Hex[]; data: Hex };
}

let counter = 0;

/** A test deployment with fresh, distinct contract addresses. */
export function fakeDeployment(fromBlock: bigint, chainId = 586_586): Deployment {
  const n = ++counter;
  const roles: Role[] = ["token", "identityRegistry", "issuance", "pauseGuard", "freezeGuard", "recovery", "registrarGuard", "distributions", "documents", "timelock"];
  const contracts = Object.fromEntries(roles.map((r, i) => [r, `0x${(n * 256 + i + 1).toString(16).padStart(40, "0")}`]));
  return parseDeployment({ id: `test-${String(n)}-${String(Date.now())}`, chainId, fromBlock, contracts });
}

/**
 * In-memory chain implementing ChainSource. Events are encoded with the real ABIs, so decoding is
 * exercised exactly as on Besu. Blocks link by parent hash; `rewrite` replaces history from a block
 * on (what a reset network or a wrong node would look like).
 */
export class FakeChain implements ChainSource {
  readonly blocks: Header[] = [];
  private readonly logsByBlock = new Map<bigint, RawLog[]>();
  private salt = "a";
  /** Test hooks to corrupt what the node returns. */
  corruptHeader: ((h: Header) => Header) | null = null;
  corruptLog: ((l: RawLog) => RawLog) | null = null;
  calls = { headers: 0, logs: 0 };

  constructor(readonly id = 586_586) {
    this.push([]);
  }

  async chainId(): Promise<number> {
    return Promise.resolve(this.id);
  }

  async head(): Promise<bigint> {
    return Promise.resolve(this.tip);
  }

  get tip(): bigint {
    return BigInt(this.blocks.length - 1);
  }

  async headers(from: bigint, to: bigint): Promise<Header[]> {
    this.calls.headers++;
    const out = this.blocks.slice(Number(from), Number(to) + 1).map((h) => ({ ...h }));
    return Promise.resolve(this.corruptHeader ? out.map(this.corruptHeader) : out);
  }

  async logs(addresses: readonly Address[], from: bigint, to: bigint): Promise<RawLog[]> {
    this.calls.logs++;
    const wanted = new Set(addresses.map((a) => a.toLowerCase()));
    const out: RawLog[] = [];
    for (let n = from; n <= to; n++) {
      for (const l of this.logsByBlock.get(n) ?? []) if (wanted.has(l.address.toLowerCase())) out.push({ ...l, topics: [...l.topics] });
    }
    return Promise.resolve(this.corruptLog ? out.map(this.corruptLog) : out);
  }

  /** Mines one block holding the given events (one transaction each) for a deployment. */
  mine(d: Deployment, events: (FakeEvent | FakeRawEvent)[] = []): Header {
    const encoded = events.map((e) => {
      const address = d.contracts[e.role];
      if (!address) throw new Error(`deployment has no ${e.role}`);
      return { address, ...("raw" in e ? e.raw : encode(e)), ...(!("raw" in e) && e.tx !== undefined ? { tx: e.tx } : {}) };
    });
    return this.push(encoded);
  }

  mineEmpty(n: number): void {
    for (let i = 0; i < n; i++) this.push([]);
  }

  /** Replaces block `from` and everything after it with blocks of different hashes (same logs). */
  rewrite(from: bigint): void {
    this.salt += "b";
    const kept = this.blocks.splice(Number(from));
    for (const old of kept) {
      const logs = this.logsByBlock.get(old.number) ?? [];
      this.push(logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })));
    }
  }

  private push(logs: { address: Address; topics: Hex[]; data: Hex; tx?: number }[]): Header {
    const number = BigInt(this.blocks.length);
    const parentHash: Hex = this.blocks.at(-1)?.hash ?? `0x${"0".repeat(64)}`;
    const hash = keccak256(toHex(`${this.salt}:${number.toString()}:${parentHash}`));
    const header: Header = { number, hash, parentHash, timestamp: 1_790_000_000n + number * 2n };
    this.blocks.push(header);
    this.logsByBlock.set(number, logs.map((l, i) => ({
      address: l.address,
      blockNumber: number,
      blockHash: hash,
      transactionHash: keccak256(toHex(`tx:${hash}:${String(l.tx ?? i)}`)),
      transactionIndex: l.tx ?? i,
      logIndex: i,
      topics: l.topics,
      data: l.data,
      removed: false,
    })));
    return header;
  }
}

/** Encodes an event with its real ABI: indexed arguments into topics, the rest into data. */
export function encode(e: FakeEvent): { topics: Hex[]; data: Hex } {
  const ev = eventAbi(e.role, e.name);
  if (!ev) throw new Error(`no event ${e.name} for ${e.role}`);
  const args = new Map(Object.entries(e.args));
  const indexed = Object.fromEntries(ev.inputs.filter((i) => i.indexed).map((i) => [i.name ?? "", args.get(i.name ?? "")]));
  const topics = encodeEventTopics({ abi: [ev], eventName: ev.name, args: indexed }).filter((t): t is Hex => typeof t === "string");
  const plain = ev.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(plain, plain.map((i) => args.get(i.name ?? "")));
  return { topics, data };
}
