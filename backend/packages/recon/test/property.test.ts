import fc from "fast-check";
import { keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { runChecks } from "../src/checks.ts";
import { parseRentKey, parseSubscriptionKey } from "../src/conventions.ts";
import type { CheckName, ReconData } from "../src/types.ts";
import { AS_OF, BANK_LEDGER, makeWorld, rebalance, wallet, type World, type WorldSpec } from "./world.ts";

/**
 * Property test: random consistent worlds (subscriptions in every state, rent distributions in
 * every status, bank statement, holdings) must give ZERO findings; injecting any single
 * discrepancy must be detected under the right check name.
 */

const sub = (outcome: "settled" | "refunded" | "pending" | "minted") =>
  fc.record({
    outcome: fc.constant(outcome),
    tokens: fc.integer({ min: 1, max: 50_000 }),
    paisaPerToken: fc.integer({ min: 1, max: 1_000_000 }),
    wallet: fc.integer({ min: 0, max: 6 }),
    web: fc.boolean(),
  });
const anySub = fc.constantFrom("settled", "refunded", "pending", "minted" as const).chain(sub);
const dist = (status: "published" | "rejected" | "finalized" | "paid") =>
  fc.record({ status: fc.constant(status), total: fc.integer({ min: 1, max: 1_000_000_000 }) });

/** At least one of everything, so every injection below has something to act on. */
const worldSpec: fc.Arbitrary<WorldSpec> = fc
  .record({
    base: fc.tuple(sub("settled"), sub("refunded"), sub("pending"), sub("minted")),
    extra: fc.array(anySub, { maxLength: 12 }),
    rentBase: fc.tuple(dist("published"), dist("rejected"), dist("finalized"), dist("paid")),
    rentExtra: fc.array(fc.constantFrom("published", "rejected", "finalized", "paid" as const).chain(dist), { maxLength: 4 }),
  })
  .chain(({ base, extra, rentBase, rentExtra }) =>
    fc.tuple(fc.shuffledSubarray([...base, ...extra], { minLength: base.length + extra.length }), fc.shuffledSubarray([...rentBase, ...rentExtra], { minLength: rentBase.length + rentExtra.length }))
      .map(([subs, rent]) => ({ subs, rent })));

const pick = <T>(xs: T[], i: number): T => {
  const v = xs[i % xs.length];
  if (v === undefined) throw new Error("nothing to pick");
  return v;
};
const mintOf = (d: ReconData, refId: string) => {
  const m = d.chain.issuances.find((x) => x.refId === refId);
  if (!m) throw new Error("no mint");
  return m;
};
/** Keeps supply and holdings consistent with the issuances after a mint was added or changed. */
function resync(d: ReconData): void {
  const holdings = new Map<string, bigint>();
  for (const m of d.chain.issuances) holdings.set(m.account, (holdings.get(m.account) ?? 0n) + (m.kind === "mint" ? m.amount : -m.amount));
  const supply = [...holdings.values()].reduce((a, b) => a + b, 0n);
  d.chain.readModel = { totalSupply: supply, holdings };
  d.chain.onChain = { totalSupply: supply, balances: new Map(holdings) };
}
const lines = (d: ReconData) => {
  const st = d.bank.statements[0];
  if (!st) throw new Error("no statement");
  return st.lines;
};
const subsOf = (w: World, outcome: string) => w.subs.filter((s) => s.outcome === outcome);
const journalByKey = (d: ReconData, key: string) => {
  const j = d.ledger.journals.find((x) => x.key === key);
  if (!j) throw new Error(`no journal ${key}`);
  return j;
};
const distBy = (d: ReconData, status: string, i: number) => pick(d.chain.distributions.filter((x) => x.status === status), i);

/** Each injection mutates a clean world and names the check that must catch it. */
const INJECTIONS: Record<string, { expect: CheckName; apply: (w: World, i: number) => void }> = {
  "missing mint for a settled subscription": {
    expect: "issuance.settled_without_mint",
    apply: (w, i) => {
      const s = pick(subsOf(w, "settled"), i);
      w.data.chain.issuances = w.data.chain.issuances.filter((m) => m.refId !== s.refId);
    },
  },
  "orphan mint": {
    expect: "issuance.orphan_mint",
    apply: (w, i) => {
      w.data.chain.issuances.push({ refId: keccak256(toHex(`orphan:${String(i)}`)), kind: "mint", account: wallet(i % 7), amount: BigInt(i + 1), blockNumber: 999n, blockTime: AS_OF, txHash: keccak256(toHex("x")) });
      resync(w.data);
    },
  },
  "mint of a refunded subscription": {
    expect: "issuance.refunded_but_minted",
    apply: (w, i) => {
      const s = pick(subsOf(w, "refunded"), i);
      w.data.chain.issuances.push({ refId: s.refId, kind: "mint", account: s.wallet, amount: s.tokens, blockNumber: 999n, blockTime: AS_OF, txHash: keccak256(toHex("y")) });
      resync(w.data);
    },
  },
  "minted amount changed": {
    expect: "issuance.amount_mismatch",
    apply: (w, i) => {
      mintOf(w.data, pick(subsOf(w, "settled"), i).refId).amount += 1n;
      resync(w.data);
    },
  },
  "minted to another wallet": {
    expect: "issuance.wallet_mismatch",
    apply: (w, i) => {
      mintOf(w.data, pick(subsOf(w, "settled"), i).refId).account = wallet(100 + i);
      resync(w.data);
    },
  },
  "paid but never minted (beyond the SLA)": {
    expect: "issuance.paid_not_minted",
    apply: (w, i) => {
      const s = pick(subsOf(w, "pending"), i);
      journalByKey(w.data, `${s.keyPrefix}:paid`).createdAt = new Date(AS_OF.getTime() - 2 * 3_600_000);
    },
  },
  "settlement amount changed": {
    expect: "issuance.settlement_mismatch",
    apply: (w, i) => {
      const j = journalByKey(w.data, `${pick(subsOf(w, "settled"), i).keyPrefix}:settled`);
      j.postings = j.postings.map((p) => ({ ...p, amount: p.amount > 0n ? p.amount + 1n : p.amount - 1n }));
    },
  },
  "duplicate ledger cash entry": {
    expect: "cash.duplicate_ledger_entry",
    apply: (w, i) => {
      const s = pick(w.subs, i);
      w.data.ledger.journals.push({ id: 10_000n, key: `dup:${String(i)}:xxxx`, kind: "subscription_paid", externalRef: s.bankRef, createdAt: AS_OF, postings: [{ account: BANK_LEDGER, amount: s.amount }, { account: "x", amount: -s.amount }] });
    },
  },
  "bank line amount changed": {
    expect: "cash.amount_mismatch",
    apply: (w, i) => {
      pick(lines(w.data), i).amount += 1n;
      rebalance(w.data);
    },
  },
  "bank line missing": {
    expect: "cash.unmatched_ledger_entry",
    apply: (w, i) => {
      const ls = lines(w.data);
      ls.splice(i % ls.length, 1);
      rebalance(w.data);
    },
  },
  "unknown bank line": {
    expect: "cash.unmatched_bank_line",
    apply: (w, i) => {
      lines(w.data).push({ lineNo: 0, valueDate: "2026-10-12", amount: BigInt(i + 1), reference: `RAAST-UNKNOWN-${String(i)}`, counterparty: "?", balance: 0n });
      rebalance(w.data);
    },
  },
  "opening balance differs": {
    expect: "cash.opening_mismatch",
    apply: (w, i) => {
      const st = w.data.bank.statements[0];
      if (st) st.opening += BigInt(i + 1);
      rebalance(w.data);
    },
  },
  "wrong statement hash on chain": {
    expect: "rent.statement_hash_mismatch",
    apply: (w, i) => {
      distBy(w.data, i % 2 ? "paid" : "finalized", i).statementHash = keccak256(toHex(`forged:${String(i)}`));
    },
  },
  "distribution total changed on chain": {
    expect: "rent.total_mismatch",
    apply: (w, i) => {
      distBy(w.data, i % 2 ? "paid" : "finalized", i).totalPaisa += 1n;
    },
  },
  "rent not booked in the ledger": {
    expect: "rent.missing_ledger",
    apply: (w, i) => {
      const id = distBy(w.data, "paid", i).id;
      w.data.ledger.journals = w.data.ledger.journals.filter((j) => !(parseRentKey(j.key)?.what === "distribution" && parseRentKey(j.key)?.id === id));
    },
  },
  "rent booked for a rejected distribution": {
    expect: "rent.booked_after_reject",
    apply: (w, i) => {
      const c = distBy(w.data, "rejected", i);
      w.data.ledger.journals.push({ id: 10_001n, key: `rent:distribution:${c.token}:${c.id.toString()}`, kind: "rent_distribution", externalRef: c.statementHash, createdAt: AS_OF, postings: [{ account: "income:rent", amount: c.totalPaisa }, { account: "payable:rent", amount: -c.totalPaisa }] });
    },
  },
  "payout batch hash differs": {
    expect: "rent.payout_batch_mismatch",
    apply: (w, i) => {
      distBy(w.data, "paid", i).payoutBatchHash = keccak256(toHex(`other-batch:${String(i)}`));
    },
  },
  "payout not in the ledger": {
    expect: "rent.payout_missing",
    apply: (w, i) => {
      const id = distBy(w.data, "paid", i).id;
      w.data.ledger.journals = w.data.ledger.journals.filter((j) => !(parseRentKey(j.key)?.what === "payout" && parseRentKey(j.key)?.id === id));
    },
  },
  "balance differs on chain": {
    expect: "holdings.balance_mismatch",
    apply: (w, i) => {
      const holders = [...w.data.chain.onChain.balances.keys()];
      const h = pick(holders, i);
      w.data.chain.onChain.balances.set(h, (w.data.chain.onChain.balances.get(h) ?? 0n) + 1n);
    },
  },
  "read-model supply differs": {
    expect: "supply.chain_vs_read_model",
    apply: (w, i) => {
      w.data.chain.readModel.totalSupply += BigInt(i + 1);
    },
  },
  "stuck outbox command": {
    expect: "integrity.outbox_stuck",
    apply: (w, i) => {
      w.data.integrity.outbox.push({ id: BigInt(i + 1), kind: "issuance.mint", status: i % 2 ? "submitted" : "review", updatedAt: new Date(AS_OF.getTime() - 3 * 3_600_000), lastError: null });
    },
  },
  "tampered ledger row": {
    expect: "integrity.ledger_chain",
    apply: (w, i) => {
      w.data.integrity.ledger.push({ journalId: String(i + 1), problem: "content does not match its hash" });
    },
  },
  "tampered signer audit": {
    expect: "integrity.signer_audit",
    apply: (w) => {
      w.data.integrity.signerAudit.push({ auditId: "7", problem: "prev_hash does not match" });
    },
  },
  "indexer verify mismatch": {
    expect: "integrity.indexer_verify",
    apply: (w) => {
      w.data.integrity.indexer.verify.problems.push("balanceOf(0x…): chain 5 vs read model 6");
    },
  },
};

describe("reconciliation checks (property)", () => {
  it("find nothing in consistent data (no false positives)", () => {
    fc.assert(
      fc.property(worldSpec, (spec) => {
        const w = makeWorld(spec);
        expect(runChecks(w.data)).toEqual([]);
        // Sanity: the generator really produced linked data.
        expect(w.data.ledger.journals.some((j) => parseSubscriptionKey(j.key))).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("detect every injected discrepancy under the right check", () => {
    const entries = Object.entries(INJECTIONS);
    fc.assert(
      fc.property(worldSpec, fc.nat({ max: entries.length - 1 }), fc.nat({ max: 1000 }), (spec, which, i) => {
        const [name, inj] = entries.at(which) ?? [];
        if (!name || !inj) throw new Error(`no injection ${String(which)}`);
        const w = makeWorld(spec);
        inj.apply(w, i);
        const found = runChecks(w.data);
        expect(found.map((x) => x.check), name).toContain(inj.expect);
        // Every injection here is money- or ownership-relevant: it must block payouts.
        expect(found.some((x) => x.severity === "blocking"), name).toBe(true);
      }),
      { numRuns: 600 },
    );
  });

  it("covers each injection at least once and every one is detected on a fixed world", () => {
    const spec: WorldSpec = {
      subs: [
        { outcome: "settled", tokens: 10, paisaPerToken: 100, wallet: 0, web: true },
        { outcome: "settled", tokens: 5, paisaPerToken: 100, wallet: 1, web: false },
        { outcome: "refunded", tokens: 3, paisaPerToken: 100, wallet: 2, web: true },
        { outcome: "pending", tokens: 2, paisaPerToken: 100, wallet: 3, web: false },
        { outcome: "minted", tokens: 1, paisaPerToken: 100, wallet: 4, web: true },
      ],
      rent: [{ status: "published", total: 100 }, { status: "rejected", total: 200 }, { status: "finalized", total: 300 }, { status: "paid", total: 400 }],
    };
    for (const [name, inj] of Object.entries(INJECTIONS)) {
      const w = makeWorld(spec);
      inj.apply(w, 1);
      expect(runChecks(w.data).map((x) => x.check), name).toContain(inj.expect);
    }
  });
});
