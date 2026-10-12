import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { checkCash, checkHoldings, checkIntegrity, checkIssuance, checkRent, checkSupply, LAG_WARN_BLOCKS, MAX_PER_CHECK, runChecks } from "../src/checks.ts";
import { dayEnd, dayStart, parseRentKey, parseSubscriptionKey, payoutBatchHash, pktDate, refIdForSubscription } from "../src/conventions.ts";
import { CHECKS, type CheckName, type Finding, type ReconData } from "../src/types.ts";
import { AS_OF, BANK, BANK_LEDGER, DAY, makeWorld, rebalance, TOKEN, wallet, type World, type WorldSpec } from "./world.ts";

/** Unit tests: each check on a small fixed world, including SLA edges, warnings and determinism. */

const SPEC: WorldSpec = {
  subs: [
    { outcome: "settled", tokens: 10, paisaPerToken: 1_000, wallet: 0, web: true },
    { outcome: "settled", tokens: 4, paisaPerToken: 1_000, wallet: 1, web: false },
    { outcome: "refunded", tokens: 3, paisaPerToken: 1_000, wallet: 2, web: true },
    { outcome: "pending", tokens: 2, paisaPerToken: 1_000, wallet: 3, web: false },
    { outcome: "minted", tokens: 1, paisaPerToken: 1_000, wallet: 4, web: true },
  ],
  rent: [{ status: "published", total: 100 }, { status: "rejected", total: 200 }, { status: "finalized", total: 300 }, { status: "paid", total: 400 }],
};
const world = (): World => makeWorld(SPEC);
const names = (fs: Finding[]): CheckName[] => fs.map((x) => x.check);
const sub = (w: World, outcome: string) => {
  const s = w.subs.find((x) => x.outcome === outcome);
  if (!s) throw new Error(outcome);
  return s;
};
const journal = (d: ReconData, key: string) => {
  const j = d.ledger.journals.find((x) => x.key === key);
  if (!j) throw new Error(key);
  return j;
};
const minutesAgo = (m: number): Date => new Date(AS_OF.getTime() - m * 60_000);

describe("conventions", () => {
  it("derive the same refId as the web prototype (web/src/lib/invest-rules.ts)", () => {
    const web = readFileSync(fileURLToPath(new URL("../../../../web/src/lib/invest-rules.ts", import.meta.url)), "utf8");
    expect(web).toContain("keccak256(stringToBytes(`property-token:subscription:${subscriptionId}`))");
    const id = "6f1c2a9e-3b4d-4c5e-8f60-7a8b9c0d1e2f";
    expect(refIdForSubscription(id)).toBe(keccak256(toHex(`property-token:subscription:${id}`)));
  });

  it("parse only well-formed keys", () => {
    expect(parseSubscriptionKey("web:sub:6f1c2a9e-3b4d-4c5e-8f60-7a8b9c0d1e2f:paid")?.phase).toBe("paid");
    expect(parseSubscriptionKey(`sub:0x${"ab".repeat(32)}:refunded`)).toEqual({ refId: `0x${"ab".repeat(32)}`, phase: "refunded" });
    for (const bad of ["web:sub:not-a-uuid:paid", `sub:0x${"AB".repeat(32)}:paid`, `sub:0x${"ab".repeat(32)}:minted`, "web:topup:x"]) {
      expect(parseSubscriptionKey(bad)).toBeNull();
    }
    expect(parseRentKey(`rent:payout:${TOKEN}:12`)).toEqual({ what: "payout", token: TOKEN, id: 12n });
    expect(parseRentKey(`rent:payout:${TOKEN}:0`)).toBeNull();
    expect(parseRentKey("rent:received:1")).toBeNull();
  });

  it("cut days at midnight Pakistan time (UTC+5)", () => {
    expect(dayStart("2026-10-12").toISOString()).toBe("2026-10-11T19:00:00.000Z");
    expect(dayEnd("2026-10-12").toISOString()).toBe("2026-10-12T19:00:00.000Z");
    expect(pktDate(new Date("2026-10-12T18:59:59.999Z"))).toBe("2026-10-12");
    expect(pktDate(new Date("2026-10-12T19:00:00.000Z"))).toBe("2026-10-13");
  });

  it("name every check with a severity", () => {
    for (const [name, severity] of Object.entries(CHECKS)) {
      expect(name).toMatch(/^[a-z]+\.[a-z_]+$/);
      expect(["blocking", "warning"]).toContain(severity);
    }
  });
});

describe("checkIssuance (M-6)", () => {
  it("is quiet for consistent data", () => {
    expect(checkIssuance(world().data)).toEqual([]);
  });

  it("respects the SLA: paid or minted moments ago is in flight, not a finding", () => {
    const w = world();
    const p = sub(w, "pending");
    journal(w.data, `${p.keyPrefix}:paid`).createdAt = minutesAgo(29);
    expect(checkIssuance(w.data)).toEqual([]);
    journal(w.data, `${p.keyPrefix}:paid`).createdAt = minutesAgo(31);
    expect(names(checkIssuance(w.data))).toEqual(["issuance.paid_not_minted"]);

    const w2 = world();
    const m = w2.data.chain.issuances.find((x) => x.refId === sub(w2, "minted").refId);
    if (!m) throw new Error("no mint");
    m.blockTime = minutesAgo(31);
    expect(names(checkIssuance(w2.data))).toEqual(["issuance.minted_not_settled"]);
  });

  it("finds settled-and-refunded, an unpaid settlement, a command without payment and duplicate commands", () => {
    const w = world();
    const s = sub(w, "settled");
    w.data.ledger.journals.push({ ...journal(w.data, `${s.keyPrefix}:settled`), id: 900n, key: `${s.keyPrefix}:refunded` });
    expect(names(checkIssuance(w.data))).toContain("issuance.settled_and_refunded");

    const w2 = world();
    const s2 = sub(w2, "settled");
    w2.data.ledger.journals = w2.data.ledger.journals.filter((j) => j.key !== `${s2.keyPrefix}:paid`);
    expect(names(checkIssuance(w2.data))).toEqual(expect.arrayContaining(["issuance.unpaid_settlement", "issuance.orphan_mint"]));

    const w3 = world();
    const ref = keccak256(toHex("no-payment"));
    w3.data.expectedMints.set(ref, { refId: ref, to: wallet(1), amount: 5n, source: "outbox", commands: 2 });
    expect(names(checkIssuance(w3.data)).sort()).toEqual(["issuance.command_without_payment", "issuance.duplicate_command"]);
  });

  it("warns (does not block) when a mint cannot be compared or a burn has no redemption convention yet", () => {
    const w = world();
    w.data.expectedMints.delete(sub(w, "settled").refId);
    w.data.chain.issuances.push({ refId: keccak256(toHex("burn")), kind: "burn", account: wallet(0), amount: 1n, blockNumber: 5n, blockTime: AS_OF, txHash: keccak256(toHex("b")) });
    const found = checkIssuance(w.data);
    expect(names(found).sort()).toEqual(["issuance.burn_not_reconciled", "issuance.unverified_amount"]);
    expect(found.every((x) => x.severity === "warning")).toBe(true);
  });
});

describe("checkSupply and checkHoldings (pinned block)", () => {
  it("compare chain, read model, holdings and mints minus burns", () => {
    const w = world();
    expect(checkSupply(w.data)).toEqual([]);
    expect(checkHoldings(w.data)).toEqual([]);
    w.data.chain.readModel.holdings.set(wallet(9), 1n);
    expect(names(checkSupply(w.data))).toEqual(["supply.holdings_sum"]);
    w.data.chain.onChain.totalSupply += 1n;
    expect(names(checkSupply(w.data)).sort()).toEqual(["supply.chain_vs_read_model", "supply.holdings_sum", "supply.issuance_net"]);
  });

  it("find a holder the read model does not know (sum of known balances below totalSupply)", () => {
    const w = world();
    w.data.chain.onChain.totalSupply += 7n;
    expect(names(checkHoldings(w.data))).toEqual(["holdings.missing_holder"]);
  });
});

describe("checkCash", () => {
  it("is quiet for consistent data and warns when nothing is configured or imported", () => {
    const w = world();
    expect(checkCash(w.data)).toEqual([]);
    w.data.bank.statements = [];
    expect(names(checkCash(w.data))).toEqual(["cash.no_statement"]);
    w.data.bank.accounts = [];
    expect(checkCash(w.data)).toEqual([expect.objectContaining({ check: "cash.not_configured", severity: "warning" })]);
  });

  it("finds a missing day, a broken opening/closing chain and a stale statement", () => {
    const w = world();
    const first = w.data.bank.statements[0];
    if (!first) throw new Error("no statement");
    // A statement two days later (one day missing), whose opening does not chain either.
    w.data.bank.statements.push({ id: 2n, account: BANK, date: "2026-10-14", opening: first.closing + 1n, closing: first.closing + 1n, lines: [] });
    const found = names(checkCash(w.data));
    expect(found.filter((x) => x === "cash.statement_gap")).toHaveLength(2);
    expect(found).toContain("cash.closing_mismatch");

    const w2 = world();
    w2.data.asOf = new Date("2026-10-15T06:00:00Z");
    w2.data.slaMs = 1e12;
    expect(names(checkCash(w2.data))).toEqual(["cash.statement_stale"]);
  });

  it("finds an unreferenced ledger entry on the bank account and a duplicate bank line", () => {
    const w = world();
    w.data.ledger.journals.push({ id: 901n, key: "manual:fix:0001", kind: "manual", externalRef: null, createdAt: minutesAgo(60), postings: [{ account: BANK_LEDGER, amount: 5n }, { account: "x", amount: -5n }] });
    expect(names(checkCash(w.data))).toEqual(expect.arrayContaining(["cash.unmatched_ledger_entry", "cash.closing_mismatch"]));

    const w2 = world();
    const st = w2.data.bank.statements[0];
    const l = st?.lines[0];
    if (!st || !l) throw new Error("no line");
    st.lines.push({ ...l });
    rebalance(w2.data);
    expect(names(checkCash(w2.data))).toEqual(expect.arrayContaining(["cash.duplicate_bank_line", "cash.closing_mismatch"]));
  });

  it("matches a refund to the bank by reference and direction (same reference as the payment)", () => {
    const w = world();
    const r = sub(w, "refunded");
    const st = w.data.bank.statements[0];
    expect(st?.lines.filter((x) => x.reference === r.bankRef).map((x) => x.amount)).toEqual([r.amount, -r.amount]);
    expect(checkCash(w.data)).toEqual([]);
  });

  it("ignores ledger entries after the last statement day (not yet on a statement)", () => {
    const w = world();
    w.data.ledger.journals.push({ id: 902n, key: "web:sub:00000000-0000-4000-8000-0000000000ff:paid", kind: "subscription_paid", externalRef: "RAAST-DEMO-TOMORROW", createdAt: dayEnd(DAY), postings: [{ account: BANK_LEDGER, amount: 5n }, { account: "x", amount: -5n }] });
    expect(checkCash(w.data)).toEqual([]);
  });
});

describe("checkRent (M-2)", () => {
  it("is quiet for consistent data", () => {
    expect(checkRent(world().data)).toEqual([]);
  });

  it("refuses payouts before finalization and ledger rent the chain does not know", () => {
    const w = world();
    const published = w.data.chain.distributions.find((x) => x.status === "published");
    if (!published) throw new Error("none");
    w.data.ledger.journals.push({ id: 903n, key: `rent:payout:${TOKEN}:${published.id.toString()}`, kind: "rent_payout", externalRef: "RAAST-BATCH-EARLY", createdAt: AS_OF, postings: [{ account: "payable:rent", amount: 1n }, { account: "y", amount: -1n }] });
    w.data.ledger.journals.push({ id: 904n, key: `rent:distribution:${TOKEN}:99`, kind: "rent_distribution", externalRef: "0x00", createdAt: AS_OF, postings: [{ account: "a", amount: 1n }, { account: "b", amount: -1n }] });
    expect(names(checkRent(w.data)).sort()).toEqual(["rent.orphan_ledger", "rent.payout_premature"]);
  });

  it("warns while a finalized distribution's payout is in the ledger but not yet recorded on chain", () => {
    const w = world();
    const fin = w.data.chain.distributions.find((x) => x.status === "finalized");
    if (!fin) throw new Error("none");
    w.data.ledger.journals.push({ id: 905n, key: `rent:payout:${TOKEN}:${fin.id.toString()}`, kind: "rent_payout", externalRef: "RAAST-BATCH-X", createdAt: AS_OF, postings: [{ account: "payable:rent", amount: fin.totalPaisa }, { account: "z", amount: -fin.totalPaisa }] });
    expect(checkRent(w.data)).toEqual([expect.objectContaining({ check: "rent.payout_not_recorded", severity: "warning" })]);
  });

  it("checks the payout amount and uses keccak256(batch reference) as the mock batch hash", () => {
    const w = world();
    const paid = w.data.chain.distributions.find((x) => x.status === "paid");
    if (!paid) throw new Error("none");
    const pj = journal(w.data, `rent:payout:${TOKEN}:${paid.id.toString()}`);
    expect(payoutBatchHash(pj.externalRef ?? "")).toBe(paid.payoutBatchHash);
    pj.postings = pj.postings.map((p) => ({ ...p, amount: p.amount > 0n ? p.amount - 1n : p.amount + 1n }));
    expect(names(checkRent(w.data))).toEqual(["rent.payout_amount_mismatch"]);
  });

  it("ignores rent journals of other tokens", () => {
    const w = world();
    w.data.ledger.journals.push({ id: 906n, key: `rent:distribution:0x${"bb".repeat(20)}:1`, kind: "rent_distribution", externalRef: "0x1", createdAt: AS_OF, postings: [{ account: "a", amount: 1n }, { account: "b", amount: -1n }] });
    expect(checkRent(w.data)).toEqual([]);
  });
});

describe("checkIntegrity", () => {
  it("blocks on a halted indexer and stuck commands, warns on lag and waiting commands", () => {
    const w = world();
    w.data.integrity.indexer.halted = "chain mismatch at block 7";
    w.data.integrity.indexer.lagBlocks = LAG_WARN_BLOCKS + 1n;
    w.data.integrity.outbox.push(
      { id: 1n, kind: "issuance.mint", status: "submitted", updatedAt: minutesAgo(31), lastError: null },
      { id: 2n, kind: "issuance.mint", status: "pending", updatedAt: minutesAgo(31), lastError: "awaiting approval" },
      { id: 3n, kind: "issuance.mint", status: "review", updatedAt: minutesAgo(29), lastError: null },
    );
    const found = checkIntegrity(w.data);
    expect(found.map((x) => [x.check, x.severity])).toEqual([
      ["integrity.indexer_halted", "blocking"],
      ["integrity.indexer_lag", "warning"],
      ["integrity.outbox_stuck", "blocking"],
      ["integrity.outbox_waiting", "warning"],
    ]);
  });

  it("reports a verify mismatch only when verify ran (ADR 0006: a mismatch is blocking)", () => {
    const w = world();
    w.data.integrity.indexer.verify = { ran: false, pinnedBlock: null, problems: ["ignored"] };
    expect(checkIntegrity(w.data)).toEqual([]);
    w.data.integrity.indexer.verify = { ran: true, pinnedBlock: 5n, problems: ["x"] };
    expect(checkIntegrity(w.data)).toEqual([expect.objectContaining({ check: "integrity.indexer_verify", severity: "blocking" })]);
  });
});

describe("runChecks", () => {
  it("is deterministic: the order of the input does not change the output", () => {
    const w = world();
    w.data.integrity.ledger.push({ journalId: "3", problem: "content does not match its hash" });
    w.data.chain.readModel.totalSupply += 1n;
    const a = runChecks(w.data);
    w.data.ledger.journals.reverse();
    w.data.chain.issuances.reverse();
    w.data.chain.distributions.reverse();
    expect(runChecks(w.data)).toEqual(a);
  });

  it(`lists at most ${String(MAX_PER_CHECK)} findings per check and counts the rest`, () => {
    const w = world();
    for (let i = 0; i < MAX_PER_CHECK + 25; i++) w.data.integrity.ledger.push({ journalId: String(i), problem: "content does not match its hash" });
    const found = runChecks(w.data).filter((x) => x.check === "integrity.ledger_chain");
    expect(found).toHaveLength(MAX_PER_CHECK + 1);
    expect(found.at(-1)?.subject).toBe("(25 more not listed)");
  });

  it("a running balance that differs from its postings is a blocking finding (RF-2)", () => {
    const w = world();
    w.data.integrity.ledgerBalances.push({ code: "web:investor:x:cash", cached: "-1000000", actual: "-100" });
    const found = runChecks(w.data).filter((x) => x.check === "integrity.ledger_balances");
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("blocking");
    expect(found[0]?.actual).toContain("-1000000");
  });

  it("truncates long text to the database limits", () => {
    const w = world();
    w.data.integrity.indexer.verify.problems.push("x".repeat(2_000));
    const f = runChecks(w.data)[0];
    expect(f?.actual?.length).toBe(500);
  });
});
