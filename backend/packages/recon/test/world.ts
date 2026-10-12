import { keccak256, toHex } from "viem";
import { addDays, payoutBatchHash, refIdForSubscription } from "../src/conventions.ts";
import type {
  BankLine,
  ChainDistribution,
  ChainIssuance,
  DistributionStatus,
  ExpectedMint,
  LedgerJournal,
  ReconData,
} from "../src/types.ts";

/**
 * Generates a CONSISTENT world: every subscription, mint, rent distribution, payout and bank line
 * agrees across chain, ledger and bank. Clean worlds must give zero findings; tests then inject one
 * discrepancy at a time.
 */

export const TOKEN = "0x00000000000000000000000000000000000000aa";
export const BANK = "TRUSTEE-ESCROW-01";
export const BANK_LEDGER = "bank:escrow";
export const DAY = "2026-10-12";
/** 17:00 PKT on DAY. */
export const AS_OF = new Date("2026-10-12T12:00:00.000Z");
export const SLA_MS = 30 * 60_000;

export interface SubSpec {
  outcome: "settled" | "refunded" | "pending" | "minted";
  tokens: number;
  paisaPerToken: number;
  wallet: number;
  web: boolean;
}

export interface WorldSpec {
  subs: SubSpec[];
  /** Rent distributions, by status, with totals. */
  rent: { status: DistributionStatus; total: number }[];
}

export interface Sub {
  refId: string;
  keyPrefix: string;
  wallet: string;
  tokens: bigint;
  amount: bigint;
  bankRef: string;
  outcome: SubSpec["outcome"];
}

export interface World {
  data: ReconData;
  subs: Sub[];
}

const h = (s: string): string => keccak256(toHex(s));
const hex12 = (n: number): string => n.toString(16).padStart(12, "0");
export const wallet = (i: number): string => `0x${(0xa11ce000 + i).toString(16).padStart(40, "0")}`;

export function makeWorld(spec: WorldSpec): World {
  const journals: LedgerJournal[] = [];
  const issuances: ChainIssuance[] = [];
  const expectedMints = new Map<string, ExpectedMint>();
  let jid = 0n;
  let block = 100n;
  // Morning of DAY (PKT), one second apart; "fresh" things happen 10 minutes before AS_OF.
  let clock = new Date("2026-10-12T04:00:00.000Z").getTime();
  const at = (): Date => new Date((clock += 1_000));
  const fresh = (): Date => new Date(AS_OF.getTime() - 10 * 60_000);
  const journal = (key: string, kind: string, externalRef: string | null, createdAt: Date, postings: [string, bigint][]): LedgerJournal => {
    const j = { id: ++jid, key, kind, externalRef, createdAt, postings: postings.map(([account, amount]) => ({ account, amount })) };
    journals.push(j);
    return j;
  };

  const subs: Sub[] = spec.subs.map((s, i) => {
    const uuid = `00000000-0000-4000-8000-${hex12(i + 1)}`;
    const refId = s.web ? refIdForSubscription(uuid) : h(`backend-sub:${String(i)}`);
    const keyPrefix = s.web ? `web:sub:${uuid}` : `sub:${refId}`;
    const tokens = BigInt(s.tokens);
    return { refId, keyPrefix, wallet: wallet(s.wallet), tokens, amount: tokens * BigInt(s.paisaPerToken), bankRef: `RAAST-DEMO-${hex12(0xb00000 + i).toUpperCase()}`, outcome: s.outcome };
  });
  for (const s of subs) {
    const investor = `web:investor:${s.refId.slice(2, 10)}:subscription`;
    const paidAt = s.outcome === "pending" || s.outcome === "minted" ? fresh() : at();
    journal(`${s.keyPrefix}:paid`, "subscription_paid", s.bankRef, paidAt, [[BANK_LEDGER, s.amount], [investor, -s.amount]]);
    expectedMints.set(s.refId, { refId: s.refId, to: s.wallet, amount: s.tokens, source: s.keyPrefix.startsWith("web:") ? "webdemo" : "outbox", commands: s.keyPrefix.startsWith("web:") ? 0 : 1 });
    if (s.outcome === "settled" || s.outcome === "minted") {
      const tx = h(`mint-tx:${s.refId}`);
      const blockTime = s.outcome === "minted" ? new Date(AS_OF.getTime() - 5 * 60_000) : at();
      issuances.push({ refId: s.refId, kind: "mint", account: s.wallet, amount: s.tokens, blockNumber: ++block, blockTime, txHash: tx });
      if (s.outcome === "settled") journal(`${s.keyPrefix}:settled`, "subscription_settled", tx, at(), [[investor, s.amount], ["web:property:capital", -s.amount]]);
    }
    if (s.outcome === "refunded") journal(`${s.keyPrefix}:refunded`, "subscription_refunded", s.bankRef, at(), [[investor, s.amount], [BANK_LEDGER, -s.amount]]);
  }

  const distributions: ChainDistribution[] = spec.rent.map((r, i) => {
    const id = BigInt(i + 1);
    const total = BigInt(r.total);
    const statementHash = h(`statement:${String(i)}`);
    journal(`tenant:rent:${String(i)}`, "rent_received", `RAAST-RENT-${hex12(i)}`, at(), [[BANK_LEDGER, total], ["income:rent", -total]]);
    if (r.status === "finalized" || r.status === "paid") {
      journal(`rent:distribution:${TOKEN}:${id.toString()}`, "rent_distribution", statementHash, at(), [["income:rent", total], ["payable:rent", -total]]);
    }
    let batch: string | null = null;
    if (r.status === "paid") {
      const ref = `RAAST-BATCH-${hex12(i)}`;
      journal(`rent:payout:${TOKEN}:${id.toString()}`, "rent_payout", ref, at(), [["payable:rent", total], [BANK_LEDGER, -total]]);
      batch = payoutBatchHash(ref);
    }
    return { id, token: TOKEN, totalPaisa: total, statementHash, status: r.status, payoutBatchHash: batch };
  });

  const holdings = new Map<string, bigint>();
  for (const m of issuances) holdings.set(m.account, (holdings.get(m.account) ?? 0n) + m.amount);
  const supply = [...holdings.values()].reduce((a, b) => a + b, 0n);

  const lines = statementLines(journals);
  const data: ReconData = {
    asOf: AS_OF,
    slaMs: SLA_MS,
    deployment: { id: "test-deployment", token: TOKEN },
    pinnedBlock: block + 10n,
    chain: {
      issuances,
      distributions,
      readModel: { totalSupply: supply, holdings },
      onChain: { totalSupply: supply, balances: new Map(holdings) },
    },
    ledger: { journals },
    expectedMints,
    bank: {
      accounts: [{ account: BANK, ledgerAccount: BANK_LEDGER }],
      statements: [{ id: 1n, account: BANK, date: DAY, opening: 0n, closing: lines.at(-1)?.balance ?? 0n, lines }],
    },
    integrity: {
      ledger: [],
      signerAudit: [],
      reconAudit: [],
      indexer: { halted: null, lagBlocks: 0n, verify: { ran: true, pinnedBlock: block + 10n, problems: [] } },
      outbox: [],
    },
  };
  return { data, subs };
}

/** What the bank shows for the escrow account: one line per ledger posting on it, same reference and amount. */
export function statementLines(journals: LedgerJournal[], opening = 0n): BankLine[] {
  let running = opening;
  const out: BankLine[] = [];
  for (const j of [...journals].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    for (const p of j.postings) {
      if (p.account !== BANK_LEDGER || !j.externalRef) continue;
      running += p.amount;
      out.push({ lineNo: out.length + 1, valueDate: DAY, amount: p.amount, reference: j.externalRef, counterparty: "test", balance: running });
    }
  }
  return out;
}

/** Recomputes running balances and the closing after a test edited the lines. */
export function rebalance(d: ReconData): void {
  for (const st of d.bank.statements) {
    let running = st.opening;
    st.lines.forEach((l, i) => {
      running += l.amount;
      l.balance = running;
      l.lineNo = i + 1;
    });
    st.closing = running;
  }
}

export { addDays };
