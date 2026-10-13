import { config } from "./config";

/**
 * Chain health straight from Besu (JSON-RPC batch, 1.5 s timeout): head, block time, QBFT
 * validators, which validator proposed each of the last blocks, peers. Read-only; one shared value
 * per two seconds for all officers, so page loads never multiply the load on the node.
 */
export interface ChainHealth {
  ok: boolean;
  error: string | null;
  chainId: number | null;
  head: number | null;
  headTime: number | null;
  avgBlockSeconds: number | null;
  peers: number | null;
  validators: { address: string; lastProposed: number | null }[];
  readMs: number;
}

const TTL_MS = 2_000;
const RECENT = 12;
let cached: { at: number; value: ChainHealth } | null = null;
let pending: Promise<ChainHealth> | null = null;

interface RpcReply {
  id: number;
  result?: unknown;
  error?: { message?: string };
}

async function rpc(calls: { method: string; params: unknown[] }[]): Promise<unknown[]> {
  const res = await fetch(config.chainRpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c.method, params: c.params }))),
    signal: AbortSignal.timeout(1_500),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const replies = (await res.json()) as RpcReply[];
  const out: unknown[] = new Array<unknown>(calls.length).fill(null);
  for (const r of replies) if (Number.isInteger(r.id) && r.id >= 0 && r.id < calls.length) out.splice(r.id, 1, r.error ? null : r.result);
  return out;
}

const hexNum = (v: unknown): number | null => (typeof v === "string" && /^0x[0-9a-f]+$/i.test(v) ? Number.parseInt(v, 16) : null);

async function read(): Promise<ChainHealth> {
  const t0 = performance.now();
  const [chainId, head, peers, validators] = await rpc([
    { method: "eth_chainId", params: [] },
    { method: "eth_blockNumber", params: [] },
    { method: "net_peerCount", params: [] },
    { method: "qbft_getValidatorsByBlockNumber", params: ["latest"] },
  ]);
  const headN = hexNum(head);
  if (headN === null) throw new Error("no block number");
  const numbers = Array.from({ length: Math.min(RECENT, headN + 1) }, (_, i) => headN - i);
  const blocks = (await rpc(numbers.map((n) => ({ method: "eth_getBlockByNumber", params: [`0x${n.toString(16)}`, false] })))) as (
    | { number?: string; timestamp?: string; miner?: string }
    | null
  )[];
  const times = blocks.map((b) => hexNum(b?.timestamp)).filter((x): x is number => x !== null);
  const last = new Map<string, number>();
  for (const b of blocks) {
    const n = hexNum(b?.number);
    const miner = typeof b?.miner === "string" ? b.miner.toLowerCase() : null;
    if (n !== null && miner && !last.has(miner)) last.set(miner, n);
  }
  const vals = Array.isArray(validators) ? validators.filter((v): v is string => typeof v === "string").map((v) => v.toLowerCase()) : [];
  const first = times.at(-1);
  const newest = times[0];
  return {
    ok: true,
    error: null,
    chainId: hexNum(chainId),
    head: headN,
    headTime: newest ?? null,
    avgBlockSeconds: first !== undefined && newest !== undefined && times.length > 1 ? (newest - first) / (times.length - 1) : null,
    peers: hexNum(peers),
    validators: vals.map((address) => ({ address, lastProposed: last.get(address) ?? null })),
    readMs: Math.round(performance.now() - t0),
  };
}

export function chainHealth(): Promise<ChainHealth> {
  if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached.value);
  pending ??= read()
    .catch(
      (e: unknown): ChainHealth => ({
        ok: false,
        error: e instanceof Error ? e.message.slice(0, 120) : "unreachable",
        chainId: null,
        head: null,
        headTime: null,
        avgBlockSeconds: null,
        peers: null,
        validators: [],
        readMs: 0,
      }),
    )
    .then((value) => {
      cached = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}
