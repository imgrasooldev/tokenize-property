import { keccak256, toHex, type Hex } from "viem";
import type { FakeEvent, FakeRawEvent } from "./fake-chain.ts";

/** One random step; the interpreter below turns it into a VALID set of contract events. */
export interface Op {
  kind: number;
  a: number;
  b: number;
  amount: number;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const WALLETS = Array.from({ length: 5 }, (_, i) => `0x${(0xa11ce00 + i).toString(16).padStart(40, "0")}`);
const IDENTITIES = Array.from({ length: 4 }, (_, i) => `0x${(0x1d000 + i).toString(16).padStart(40, "0")}`);
const OPERATOR = `0x${"0e".repeat(20)}`;

const h = (s: string): Hex => keccak256(toHex(s));
const pick = <T>(xs: readonly T[], i: number): T => {
  const v = xs.at(i % xs.length);
  if (v === undefined) throw new Error("empty list");
  return v;
};

/**
 * Interprets random ops as what the real contracts would emit, keeping every invariant (balances,
 * refIds, statuses), so the read model must accept all of it. `salt` keeps refIds unique per run.
 * Returns one list of events per transaction.
 */
export function scenario(ops: Op[], salt: string): (FakeEvent | FakeRawEvent)[][] {
  const balance = new Map<string, bigint>();
  const frozen = new Map<string, bigint>();
  const addrFrozen = new Map<string, boolean>();
  const registered = new Map<string, string>(); // wallet -> identity
  let paused = true;
  let cap = 0n;
  let refs = 0;
  const dists: string[] = []; // status by id - 1
  const docs: { superseded: boolean }[] = [];
  const recoveries: string[] = [];
  const txs: (FakeEvent | FakeRawEvent)[][] = [];
  const ref = (): Hex => h(`${salt}:ref:${String(++refs)}`);
  const bal = (w: string): bigint => balance.get(w) ?? 0n;

  for (const op of ops) {
    const w = pick(WALLETS, op.a);
    const v = pick(WALLETS, op.b);
    const amount = BigInt(op.amount);
    switch (op.kind % 15) {
      case 0: // mint
        balance.set(w, bal(w) + amount);
        txs.push([
          { role: "issuance", name: "Minted", args: { to: w, amount, refId: ref() } },
          { role: "token", name: "Transfer", args: { from: ZERO, to: w, value: amount } },
        ]);
        break;
      case 1: { // transfer (possibly zero)
        const x = bal(w) === 0n ? 0n : amount % (bal(w) + 1n);
        if (x > 0n) {
          balance.set(w, bal(w) - x);
          balance.set(v, bal(v) + x);
        }
        txs.push([{ role: "token", name: "Transfer", args: { from: w, to: v, value: x } }]);
        break;
      }
      case 2: { // burn
        if (bal(w) === 0n) break;
        const x = (amount % bal(w)) + 1n;
        balance.set(w, bal(w) - x);
        txs.push([
          { role: "token", name: "Transfer", args: { from: w, to: ZERO, value: x } },
          { role: "issuance", name: "Burned", args: { from: w, amount: x, refId: ref() } },
        ]);
        break;
      }
      case 3: // partial freeze
        frozen.set(w, (frozen.get(w) ?? 0n) + amount);
        txs.push([
          { role: "token", name: "TokensFrozen", args: { _userAddress: w, _amount: amount } },
          { role: "freezeGuard", name: "PartialFreezeSet", args: { account: w, amount, frozen: true, caseId: h(`case:${String(op.b)}`) } },
        ]);
        break;
      case 4: { // partial unfreeze
        const f = frozen.get(w) ?? 0n;
        const x = f === 0n ? 0n : amount % (f + 1n);
        frozen.set(w, f - x);
        txs.push([
          { role: "token", name: "TokensUnfrozen", args: { _userAddress: w, _amount: x } },
          { role: "freezeGuard", name: "PartialFreezeSet", args: { account: w, amount: x, frozen: false, caseId: h(`case:${String(op.b)}`) } },
        ]);
        break;
      }
      case 5: { // address freeze toggle
        const next = !(addrFrozen.get(w) ?? false);
        addrFrozen.set(w, next);
        txs.push([
          { role: "token", name: "AddressFrozen", args: { _userAddress: w, _isFrozen: next, _owner: OPERATOR } },
          { role: "freezeGuard", name: "AddressFreezeSet", args: { account: w, frozen: next, caseId: h(`case:${String(op.a)}`) } },
        ]);
        break;
      }
      case 6: // pause / unpause through PauseGuard
        txs.push(paused
          ? [{ role: "token", name: "Unpaused", args: { _userAddress: OPERATOR } }, { role: "pauseGuard", name: "Unpaused", args: { by: OPERATOR } }]
          : [{ role: "token", name: "Paused", args: { _userAddress: OPERATOR } }, { role: "pauseGuard", name: "Paused", args: { by: OPERATOR, reason: `Incident ${String(op.a)} – Halt` } }]);
        paused = !paused;
        break;
      case 7: // trustee cap
        txs.push([{ role: "issuance", name: "TrusteeCapSet", args: { previous: cap, current: amount * 1000n } }]);
        cap = amount * 1000n;
        break;
      case 8: { // distributions: publish, then reject or finalize, then pay
        const open = dists.findIndex((s) => s === "published");
        const done = dists.findIndex((s) => s === "finalized");
        if (open >= 0 && op.b % 3 !== 0) {
          const id = BigInt(open + 1);
          if (op.b % 2 === 0) {
            dists.splice(open, 1, "rejected");
            txs.push([{ role: "distributions", name: "DistributionRejected", args: { id, reason: `Wrong Root ${String(op.a)}` } }]);
          } else {
            dists.splice(open, 1, "finalized");
            txs.push([{ role: "distributions", name: "DistributionFinalized", args: { id } }]);
          }
        } else if (done >= 0 && op.a % 2 === 0) {
          dists.splice(done, 1, "paid");
          txs.push([{ role: "distributions", name: "PayoutRecorded", args: { id: BigInt(done + 1), payoutBatchHash: h(`payout:${String(done)}`) } }]);
        } else {
          dists.push("published");
          txs.push([{ role: "distributions", name: "DistributionPublished", args: {
            id: BigInt(dists.length), token: WALLETS[0], recordBlock: BigInt(op.a), merkleRoot: h(`root:${String(dists.length)}`),
            totalPaisa: amount * 100n, statementHash: h(`statement:${String(dists.length)}`),
          } }]);
        }
        break;
      }
      case 9: { // documents: add or supersede
        const current = docs.map((d, i) => (d.superseded ? -1 : i)).filter((i) => i >= 0);
        if (current.length >= 2 && op.b % 2 === 0) {
          const oldId = pick(current, op.a);
          const newId = pick(current.filter((i) => i !== oldId), op.b);
          const oldDoc = docs.at(oldId);
          if (oldDoc) oldDoc.superseded = true;
          txs.push([{ role: "documents", name: "DocumentSuperseded", args: { oldId: BigInt(oldId + 1), newId: BigInt(newId + 1) } }]);
        } else {
          docs.push({ superseded: false });
          txs.push([{ role: "documents", name: "DocumentAdded", args: {
            id: BigInt(docs.length), token: WALLETS[0], docType: op.a % 10, sha256Hash: h(`doc:${String(docs.length)}`), uri: `vault://Deeds/Doc-${String(docs.length)}.PDF`,
          } }]);
        }
        break;
      }
      case 10: { // recovery: propose, execute or cancel
        const pending = recoveries.findIndex((s) => s === "pending");
        if (pending >= 0 && op.b % 3 !== 0) {
          const id = BigInt(pending + 1);
          if (op.b % 2 === 0) {
            recoveries.splice(pending, 1, "executed");
            txs.push([{ role: "recovery", name: "RecoveryExecuted", args: { id } }]);
          } else {
            recoveries.splice(pending, 1, "cancelled");
            txs.push([{ role: "recovery", name: "RecoveryCancelled", args: { id, by: OPERATOR } }]);
          }
        } else {
          recoveries.push("pending");
          const wallet = op.a % 2 === 0;
          txs.push([{ role: "recovery", name: "RecoveryProposed", args: {
            id: BigInt(recoveries.length), kind: wallet ? 0 : 1, from: w, to: v, onchainId: wallet ? pick(IDENTITIES, op.a) : ZERO,
            amount: wallet ? 0n : amount, evidenceHash: h(`evidence:${String(recoveries.length)}`), eta: BigInt(1_790_000_000 + op.a),
          } }]);
        }
        break;
      }
      case 11: { // identity registry: register, remove, country, identity update
        const identity = registered.get(w);
        if (identity === undefined) {
          const id = pick(IDENTITIES, op.b);
          registered.set(w, id);
          txs.push([{ role: "identityRegistry", name: "IdentityRegistered", args: { investorAddress: w, identity: id } }]);
        } else if (op.b % 3 === 0) {
          registered.delete(w);
          txs.push([{ role: "identityRegistry", name: "IdentityRemoved", args: { investorAddress: w, identity } }]);
        } else if (op.b % 3 === 1) {
          txs.push([{ role: "identityRegistry", name: "CountryUpdated", args: { investorAddress: w, country: 586 + (op.a % 3) } }]);
        } else {
          const next = pick(IDENTITIES, op.a + 1);
          for (const [k, val] of registered) if (val === identity) registered.set(k, next);
          txs.push([{ role: "identityRegistry", name: "IdentityUpdated", args: { oldIdentity: identity, newIdentity: next } }]);
        }
        break;
      }
      case 12: // a log the ABI does not know: kept raw
        txs.push([{ role: "token", raw: { topics: [h(`unknown:${String(op.a)}`)], data: toHex(op.amount, { size: 32 }) } }]);
        break;
      case 13: { // governance events: raw history only, the read model must pass over them
        const safe = `0x${(0x5afe00 + op.a).toString(16).padStart(40, "0")}`;
        txs.push([[
          { role: "timelock", name: "MinDelayChange", args: { oldDuration: 60n, newDuration: BigInt(60 + op.a) } },
          { role: "distributions", name: "OpsSafeSet", args: { previous: ZERO, current: safe } },
          { role: "documents", name: "OwnershipTransferred", args: { previousOwner: ZERO, newOwner: safe } },
          { role: "recovery", name: "TrusteeSafeSet", args: { previous: ZERO, current: safe } },
          { role: "issuance", name: "IssuerSet", args: { previous: ZERO, current: safe } },
          { role: "token", name: "Approval", args: { owner: w, spender: v, value: amount } },
        ][op.b % 6] as FakeEvent]);
        break;
      }
      case 14: { // registration through RegistrarGuard: the guard emits first, then calls the registry (as on chain)
        if (registered.has(w)) break;
        const id = pick(IDENTITIES, op.a);
        registered.set(w, id);
        txs.push([
          { role: "registrarGuard", name: "InvestorRegistered", args: { account: w, identity: id, country: 586 } },
          { role: "identityRegistry", name: "IdentityRegistered", args: { investorAddress: w, identity: id } },
        ]);
        break;
      }
    }
  }
  return txs;
}
