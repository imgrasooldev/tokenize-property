import { createHash } from "node:crypto";
import type { Args } from "./decode.ts";
import type { Deployment, Hex, Role } from "./deployment.ts";

/**
 * Reference read model in memory: a second, independent implementation of the derivation rules
 * in chain.derive (migration 0005_indexer.sql). `verify` folds the chain through it and compares the
 * result with the database; the property tests use it as the oracle. Two implementations that must
 * agree catch a bug in either one, which a rebuild with the same code could not.
 */

export interface ModelEvent {
  blockNumber: bigint;
  blockHash: Hex;
  logIndex: number;
  txHash: Hex;
  txIndex: number;
  address: string;
  role: Role;
  name: string | null;
  args: Args | null;
  topics: readonly Hex[];
  data: Hex;
}

/** The comparable state of one deployment's read model. Every value is a string, number, boolean or null. */
export interface Snapshot {
  token: { totalSupply: string; trusteeCap: string; paused: boolean; pauseReason: string | null; pausedBy: string | null };
  holdings: Record<string, string>;
  freezes: Record<string, { addressFrozen: boolean; frozenAmount: string }>;
  issuances: Record<string, { kind: string; account: string; amount: string; block: string }>;
  distributions: Record<string, {
    token: string; recordBlock: string; merkleRoot: string; totalPaisa: string; statementHash: string;
    status: string; rejectReason: string | null; payoutBatchHash: string | null;
  }>;
  documents: Record<string, { token: string; docType: number; sha256Hash: string; uri: string; supersededBy: string | null }>;
  recoveries: Record<string, {
    kind: string; from: string; to: string; onchainId: string; amount: string; evidenceHash: string; eta: string;
    status: string; cancelledBy: string | null;
  }>;
  investors: Record<string, { identity: string | null; country: number | null; registered: boolean; identityStale: boolean }>;
  counts: { events: number; transfers: number; freezeActions: number };
  /** SHA-256 over the canonical lines of each history table, in chain order. */
  digests: { events: string; transfers: string; freezeActions: string };
}

export class InvariantError extends Error {
  override name = "InvariantError";
}

const ZERO = "0x0000000000000000000000000000000000000000";

/** JSON with sorted keys, so that the same value always gives the same text (jsonb reorders keys). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function eventLine(e: { blockNumber: bigint | string; logIndex: number; blockHash: string; txHash: string; txIndex: number; address: string; name: string | null; args: unknown; topics: readonly string[]; data: string }): string {
  return [String(e.blockNumber), String(e.logIndex), e.blockHash, e.txHash, String(e.txIndex), e.address, e.name ?? "", canonicalJson(e.args), e.topics.join(","), e.data].join("|");
}

export function transferLine(t: { blockNumber: bigint | string; logIndex: number; txHash: string; from: string; to: string; amount: string; kind: string }): string {
  return [String(t.blockNumber), String(t.logIndex), t.txHash, t.from, t.to, t.amount, t.kind].join("|");
}

export function freezeActionLine(f: { blockNumber: bigint | string; logIndex: number; holder: string; scope: string; frozen: boolean; amount: string | null; caseId: string }): string {
  return [String(f.blockNumber), String(f.logIndex), f.holder, f.scope, String(f.frozen), f.amount ?? "", f.caseId].join("|");
}

/** Running SHA-256 over lines. */
export class Digest {
  private readonly hash = createHash("sha256");
  count = 0;
  add(line: string): void {
    this.hash.update(line).update("\n");
    this.count++;
  }
  hex(): string {
    return this.hash.copy().digest("hex");
  }
}

/** Own property of a plain record, never an inherited one (no prototype keys). */
export function own<T>(o: Readonly<Record<string, T>>, k: string): T | undefined {
  return Object.hasOwn(o, k) ? (Object.getOwnPropertyDescriptor(o, k)?.value as T) : undefined;
}

const str = (a: Args, k: string): string => {
  const v = own(a, k);
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  throw new InvariantError(`event argument ${k} is missing`);
};
const big = (a: Args, k: string): bigint => BigInt(str(a, k));
const num = (a: Args, k: string): number => Number(str(a, k));
const bool = (a: Args, k: string): boolean => str(a, k) === "true";

export class ReadModel {
  private totalSupply = 0n;
  private trusteeCap = 0n;
  private paused = true;
  private pauseReason: string | null = null;
  private pausedBy: string | null = null;
  private readonly holdings = new Map<string, bigint>();
  private readonly freezes = new Map<string, { addressFrozen: boolean; frozenAmount: bigint }>();
  private readonly issuances = new Map<string, Snapshot["issuances"][string]>();
  private readonly distributions = new Map<string, Snapshot["distributions"][string]>();
  private readonly documents = new Map<string, Snapshot["documents"][string]>();
  private readonly recoveries = new Map<string, Snapshot["recoveries"][string]>();
  private readonly investors = new Map<string, Snapshot["investors"][string]>();
  private readonly events = new Digest();
  private readonly transfers = new Digest();
  private readonly freezeActions = new Digest();

  constructor(private readonly deployment: Deployment) {}

  apply(e: ModelEvent): void {
    this.events.add(eventLine(e));
    if (e.name === null || e.args === null) return;
    const a = e.args;
    const block = e.blockNumber.toString();
    switch (e.role) {
      case "token":
        this.token(e, a);
        return;
      case "issuance":
        if (e.name === "Minted" || e.name === "Burned") {
          const ref = str(a, "refId");
          if (this.issuances.has(ref)) throw new InvariantError(`refId ${ref} used twice (I-11) at block ${block}`);
          this.issuances.set(ref, { kind: e.name === "Minted" ? "mint" : "burn", account: str(a, e.name === "Minted" ? "to" : "from"), amount: str(a, "amount"), block });
        } else if (e.name === "TrusteeCapSet") {
          this.trusteeCap = big(a, "current");
        }
        return;
      case "pauseGuard":
        if (e.name === "Paused") {
          this.pauseReason = str(a, "reason");
          this.pausedBy = str(a, "by");
        }
        return;
      case "freezeGuard":
        if (e.name === "AddressFreezeSet" || e.name === "PartialFreezeSet") {
          this.freezeActions.add(freezeActionLine({
            blockNumber: e.blockNumber, logIndex: e.logIndex, holder: str(a, "account"),
            scope: e.name === "AddressFreezeSet" ? "address" : "partial", frozen: bool(a, "frozen"),
            amount: e.name === "PartialFreezeSet" ? str(a, "amount") : null, caseId: str(a, "caseId"),
          }));
        }
        return;
      case "recovery":
        this.recovery(e, a, block);
        return;
      case "identityRegistry":
        this.identity(e, a, block);
        return;
      case "registrarGuard":
        if (e.name === "InvestorRegistered" && this.deployment.contracts.identityRegistry) {
          const wallet = str(a, "account");
          const existing = this.investors.get(wallet);
          // Emitted BEFORE the identity registry call: only the country; IdentityRegistered registers.
          if (existing) existing.country = num(a, "country");
          else this.investors.set(wallet, { identity: null, country: num(a, "country"), registered: false, identityStale: false });
        }
        return;
      case "distributions":
        this.distribution(e, a, block);
        return;
      case "documents":
        this.document(e, a, block);
        return;
      case "timelock":
      case "idFactory":
        return;
    }
  }

  private token(e: ModelEvent, a: Args): void {
    const block = e.blockNumber.toString();
    switch (e.name) {
      case "Transfer": {
        const from = str(a, "from");
        const to = str(a, "to");
        const value = big(a, "value");
        this.transfers.add(transferLine({
          blockNumber: e.blockNumber, logIndex: e.logIndex, txHash: e.txHash, from, to, amount: value.toString(),
          kind: from === ZERO ? "mint" : to === ZERO ? "burn" : "transfer",
        }));
        if (from === ZERO) this.totalSupply += value;
        else {
          const held = this.holdings.get(from);
          if (held === undefined || held < value) {
            if (value > 0n) throw new InvariantError(`balance of ${from} would go negative at block ${block}`);
          } else this.holdings.set(from, held - value);
        }
        if (to === ZERO) {
          if (this.totalSupply < value) throw new InvariantError(`total supply would go negative at block ${block}`);
          this.totalSupply -= value;
        } else this.holdings.set(to, (this.holdings.get(to) ?? 0n) + value);
        return;
      }
      case "Paused":
        this.paused = true;
        return;
      case "Unpaused":
        this.paused = false;
        this.pauseReason = null;
        this.pausedBy = null;
        return;
      case "AddressFrozen":
        this.freeze(str(a, "_userAddress")).addressFrozen = bool(a, "_isFrozen");
        return;
      case "TokensFrozen":
        this.freeze(str(a, "_userAddress")).frozenAmount += big(a, "_amount");
        return;
      case "TokensUnfrozen": {
        const amount = big(a, "_amount");
        const f = this.freezes.get(str(a, "_userAddress"));
        if (!f || f.frozenAmount < amount) {
          if (amount > 0n) throw new InvariantError(`frozen amount of ${str(a, "_userAddress")} would go negative at block ${block}`);
        } else f.frozenAmount -= amount;
        return;
      }
      default:
        return;
    }
  }

  private freeze(holder: string): { addressFrozen: boolean; frozenAmount: bigint } {
    let f = this.freezes.get(holder);
    if (!f) {
      f = { addressFrozen: false, frozenAmount: 0n };
      this.freezes.set(holder, f);
    }
    return f;
  }

  private recovery(e: ModelEvent, a: Args, block: string): void {
    if (e.name === "RecoveryProposed") {
      const id = str(a, "id");
      if (this.recoveries.has(id)) throw new InvariantError(`recovery ${id} proposed twice at block ${block}`);
      this.recoveries.set(id, {
        kind: num(a, "kind") === 0 ? "wallet_recovery" : "forced_transfer", from: str(a, "from"), to: str(a, "to"),
        onchainId: str(a, "onchainId"), amount: str(a, "amount"), evidenceHash: str(a, "evidenceHash"), eta: str(a, "eta"),
        status: "pending", cancelledBy: null,
      });
    } else if (e.name === "RecoveryExecuted" || e.name === "RecoveryCancelled") {
      const id = str(a, "id");
      const r = this.recoveries.get(id);
      if (r?.status !== "pending") throw new InvariantError(`recovery ${id} closed while not pending (I-13) at block ${block}`);
      r.status = e.name === "RecoveryExecuted" ? "executed" : "cancelled";
      r.cancelledBy = e.name === "RecoveryCancelled" ? str(a, "by") : null;
    }
  }

  private identity(e: ModelEvent, a: Args, block: string): void {
    switch (e.name) {
      case "IdentityRegistered": {
        const wallet = str(a, "investorAddress");
        const existing = this.investors.get(wallet);
        if (existing?.registered) throw new InvariantError(`wallet ${wallet} registered twice at block ${block}`);
        this.investors.set(wallet, { identity: str(a, "identity"), country: existing?.country ?? null, registered: true, identityStale: false });
        return;
      }
      case "IdentityRemoved": {
        const wallet = str(a, "investorAddress");
        const inv = this.investors.get(wallet);
        if (!inv?.registered) throw new InvariantError(`wallet ${wallet} removed while not registered at block ${block}`);
        this.investors.set(wallet, { identity: null, country: null, registered: false, identityStale: false });
        return;
      }
      case "CountryUpdated": {
        const inv = this.investors.get(str(a, "investorAddress"));
        if (inv) inv.country = num(a, "country");
        return;
      }
      case "IdentityUpdated": {
        const old = str(a, "oldIdentity");
        const matches = [...this.investors.values()].filter((i) => i.registered && i.identity === old);
        if (matches.length === 1 && matches[0]) matches[0].identity = str(a, "newIdentity");
        else for (const m of matches) m.identityStale = true;
        return;
      }
      default:
        return;
    }
  }

  private distribution(e: ModelEvent, a: Args, block: string): void {
    if (e.name === "DistributionPublished") {
      const id = str(a, "id");
      if (this.distributions.has(id)) throw new InvariantError(`distribution ${id} published twice (I-14) at block ${block}`);
      this.distributions.set(id, {
        token: str(a, "token"), recordBlock: str(a, "recordBlock"), merkleRoot: str(a, "merkleRoot"), totalPaisa: str(a, "totalPaisa"),
        statementHash: str(a, "statementHash"), status: "published", rejectReason: null, payoutBatchHash: null,
      });
      return;
    }
    const next = { DistributionRejected: "rejected", DistributionFinalized: "finalized", PayoutRecorded: "paid" }[e.name ?? ""];
    if (!next) return;
    const id = str(a, "id");
    const d = this.distributions.get(id);
    const from = next === "paid" ? "finalized" : "published";
    if (d?.status !== from) throw new InvariantError(`distribution ${id}: ${e.name ?? ""} in the wrong status (I-14) at block ${block}`);
    d.status = next;
    if (next === "rejected") d.rejectReason = str(a, "reason");
    if (next === "paid") d.payoutBatchHash = str(a, "payoutBatchHash");
  }

  private document(e: ModelEvent, a: Args, block: string): void {
    if (e.name === "DocumentAdded") {
      const id = str(a, "id");
      if (this.documents.has(id)) throw new InvariantError(`document ${id} added twice (I-15) at block ${block}`);
      this.documents.set(id, { token: str(a, "token"), docType: num(a, "docType"), sha256Hash: str(a, "sha256Hash"), uri: str(a, "uri"), supersededBy: null });
    } else if (e.name === "DocumentSuperseded") {
      const old = this.documents.get(str(a, "oldId"));
      if (!old || old.supersededBy !== null) throw new InvariantError(`document ${str(a, "oldId")} superseded twice or unknown (I-15) at block ${block}`);
      old.supersededBy = str(a, "newId");
    }
  }

  snapshot(): Snapshot {
    const sorted = <T>(m: Map<string, T>, f: (v: T) => unknown = (v) => v): Record<string, never> =>
      Object.fromEntries([...m.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, v]) => [k, structuredClone(f(v))])) as Record<string, never>;
    return {
      token: {
        totalSupply: this.totalSupply.toString(), trusteeCap: this.trusteeCap.toString(), paused: this.paused,
        pauseReason: this.pauseReason, pausedBy: this.pausedBy,
      },
      holdings: sorted(this.holdings, (v) => v.toString()),
      freezes: sorted(this.freezes, (v) => ({ addressFrozen: v.addressFrozen, frozenAmount: v.frozenAmount.toString() })),
      issuances: sorted(this.issuances),
      distributions: sorted(this.distributions),
      documents: sorted(this.documents),
      recoveries: sorted(this.recoveries),
      investors: sorted(this.investors),
      counts: { events: this.events.count, transfers: this.transfers.count, freezeActions: this.freezeActions.count },
      digests: { events: this.events.hex(), transfers: this.transfers.hex(), freezeActions: this.freezeActions.hex() },
    };
  }
}

/** Human-readable differences between two snapshots (empty when equal). */
export function diffSnapshots(expected: Snapshot, actual: Snapshot, limit = 50): string[] {
  const out: string[] = [];
  const walk = (path: string, a: unknown, b: unknown): void => {
    if (out.length >= limit) return;
    if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of [...keys].sort()) walk(`${path}.${k}`, own(a as Record<string, unknown>, k), own(b as Record<string, unknown>, k));
      return;
    }
    if (a !== b) out.push(`${path.slice(1)}: chain ${JSON.stringify(a)} vs read model ${JSON.stringify(b)}`);
  };
  walk("", expected, actual);
  return out;
}
