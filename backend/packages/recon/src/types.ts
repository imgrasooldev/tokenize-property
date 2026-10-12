/**
 * The data a reconciliation run compares, normalised so every check is a pure, deterministic
 * function of it (the property test drives the checks with generated data of exactly this shape).
 * Amounts are bigint: PKR in paisa, tokens in units. Addresses and hashes are lower-case hex.
 */

export type Severity = "blocking" | "warning";

/** Every finding a check can report, with its default severity. The names are stable (alerts, ADR 0007). */
export const CHECKS = {
  // Tokens and issuance (threat M-6)
  "issuance.orphan_mint": "blocking",
  "issuance.paid_not_minted": "blocking",
  "issuance.minted_not_settled": "blocking",
  "issuance.settled_without_mint": "blocking",
  "issuance.refunded_but_minted": "blocking",
  "issuance.settled_and_refunded": "blocking",
  "issuance.settlement_mismatch": "blocking",
  "issuance.unpaid_settlement": "blocking",
  "issuance.duplicate_payment": "blocking",
  "issuance.amount_mismatch": "blocking",
  "issuance.wallet_mismatch": "blocking",
  "issuance.command_without_payment": "blocking",
  "issuance.duplicate_command": "blocking",
  "issuance.unverified_amount": "warning",
  "issuance.burn_not_reconciled": "warning",
  // Supply and holdings at the pinned block
  "supply.chain_vs_read_model": "blocking",
  "supply.holdings_sum": "blocking",
  "supply.issuance_net": "blocking",
  "holdings.balance_mismatch": "blocking",
  "holdings.missing_holder": "blocking",
  // Cash: ledger vs bank statements
  "cash.not_configured": "warning",
  "cash.no_statement": "warning",
  "cash.statement_stale": "warning",
  "cash.statement_gap": "blocking",
  "cash.opening_mismatch": "blocking",
  "cash.closing_mismatch": "blocking",
  "cash.unmatched_bank_line": "blocking",
  "cash.unmatched_ledger_entry": "blocking",
  "cash.duplicate_ledger_entry": "blocking",
  "cash.duplicate_bank_line": "blocking",
  "cash.amount_mismatch": "blocking",
  // Rent (threat M-2)
  "rent.missing_ledger": "blocking",
  "rent.statement_hash_mismatch": "blocking",
  "rent.total_mismatch": "blocking",
  "rent.booked_after_reject": "blocking",
  "rent.orphan_ledger": "blocking",
  "rent.payout_premature": "blocking",
  "rent.payout_missing": "blocking",
  "rent.payout_batch_mismatch": "blocking",
  "rent.payout_amount_mismatch": "blocking",
  "rent.payout_not_recorded": "warning",
  // Integrity of the records themselves
  "integrity.ledger_chain": "blocking",
  "integrity.ledger_balances": "blocking",
  "integrity.signer_audit": "blocking",
  "integrity.recon_audit": "blocking",
  "integrity.indexer_halted": "blocking",
  "integrity.indexer_verify": "blocking",
  "integrity.indexer_lag": "warning",
  "integrity.outbox_stuck": "blocking",
  "integrity.outbox_waiting": "warning",
} as const satisfies Record<string, Severity>;

export type CheckName = keyof typeof CHECKS;

export interface Finding {
  check: CheckName;
  severity: Severity;
  /** What the finding is about, e.g. "refId 0x…" or "statement TRUSTEE-ESCROW 2026-10-12". */
  subject: string;
  expected?: string;
  actual?: string;
  detail?: Record<string, string | number | boolean | null>;
}

export interface LedgerPosting {
  account: string;
  amount: bigint;
}

export interface LedgerJournal {
  id: bigint;
  key: string;
  kind: string;
  externalRef: string | null;
  createdAt: Date;
  postings: LedgerPosting[];
}

export interface ChainIssuance {
  refId: string;
  kind: "mint" | "burn";
  account: string;
  amount: bigint;
  blockNumber: bigint;
  blockTime: Date;
  txHash: string;
}

export type DistributionStatus = "published" | "rejected" | "finalized" | "paid";

export interface ChainDistribution {
  id: bigint;
  token: string;
  totalPaisa: bigint;
  statementHash: string;
  status: DistributionStatus;
  payoutBatchHash: string | null;
}

/** What a mint for a refId is supposed to be: from the outbox command or the web prototype's subscription. */
export interface ExpectedMint {
  refId: string;
  to: string;
  amount: bigint;
  source: "outbox" | "webdemo";
  /** Outbox commands for this refId (more than one is a finding). */
  commands: number;
}

export interface BankLine {
  lineNo: number;
  valueDate: string;
  amount: bigint;
  reference: string;
  counterparty: string;
  balance: bigint;
}

export interface BankStatement {
  id: bigint;
  account: string;
  /** YYYY-MM-DD, a Pakistan (PKT, UTC+5) business day. */
  date: string;
  opening: bigint;
  closing: bigint;
  lines: BankLine[];
}

export interface BankAccount {
  account: string;
  ledgerAccount: string;
}

export interface OutboxCommand {
  id: bigint;
  kind: string;
  status: "pending" | "claimed" | "submitted" | "review";
  updatedAt: Date;
  lastError: string | null;
}

export interface ReconData {
  /** Database time of the snapshot; all ages are measured from it. */
  asOf: Date;
  /** How long a step may legitimately be in flight (payment -> mint -> settlement, outbox commands). */
  slaMs: number;
  deployment: { id: string; token: string };
  pinnedBlock: bigint;
  chain: {
    issuances: ChainIssuance[];
    distributions: ChainDistribution[];
    /** The read model at the pinned block. */
    readModel: { totalSupply: bigint; holdings: Map<string, bigint> };
    /** The contracts' own answers at the pinned block (totalSupply, balanceOf of every read-model holder). */
    onChain: { totalSupply: bigint; balances: Map<string, bigint> };
  };
  ledger: { journals: LedgerJournal[] };
  expectedMints: Map<string, ExpectedMint>;
  bank: {
    accounts: BankAccount[];
    statements: BankStatement[];
    /**
     * Submitted payout batches (Step 5g): batch reference -> 0x-prefixed SHA-256 of the bank file.
     * A distribution paid through such a batch must carry this hash on chain (ADR 0009).
     */
    payoutFiles: Map<string, string>;
  };
  integrity: {
    ledger: { journalId: string; problem: string }[];
    /** Accounts whose running balance differs from the sum of their postings (migration 0008, RF-2). */
    ledgerBalances: { code: string; cached: string | null; actual: string }[];
    signerAudit: { auditId: string; problem: string }[];
    reconAudit: { auditId: string | null; problem: string }[];
    indexer: { halted: string | null; lagBlocks: bigint | null; verify: { ran: boolean; pinnedBlock: bigint | null; problems: string[] } };
    outbox: OutboxCommand[];
  };
}
