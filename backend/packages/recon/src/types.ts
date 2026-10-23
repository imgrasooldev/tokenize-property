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
  // S-05 (migration 0027): replaces the former warning issuance.burn_not_reconciled.
  "issuance.orphan_burn": "blocking",
  "issuance.burn_amount_mismatch": "blocking",
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
  "rent.payout_held": "warning",
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
  // Offerings (spec S-02 §8, ADR 0007 amendment 2026-10-13)
  "offering.over_hard_cap": "blocking",
  "offering.ref_id_mismatch": "blocking",
  "offering.state_mismatch": "blocking",
  "offering.escrow_mismatch": "blocking",
  "offering.paid_after_failure": "warning",
  // Warning, not blocking: a freeze would stop the very refunds that cure it (refunds need the gate).
  "offering.refund_overdue": "warning",
  "offering.mint_outside_window": "blocking",
  "offering.allocation_mismatch": "blocking",
  "offering.cap_headroom": "blocking",
  "offering.payment_anomaly": "blocking",
  // Recovery, succession and reversals (spec S-06 section 14.7, migration 0020)
  "recovery.unmatched": "blocking",
  // A cancelled request moved nothing; still worth a look (the local chain/flow.py scenario has one).
  "recovery.unmatched_cancelled": "warning",
  "recovery.reversal_unmatched": "blocking",
  // Secondary transfers, phase 0 (spec S-04 section 16.8, migration 0028; rules in transfer.reconcile())
  "transfer.unapproved": "blocking",
  "transfer.settlement_mismatch": "blocking",
  "transfer.register_mismatch": "blocking",
  "transfer.escrow_residual": "blocking",
  "transfer.paid_not_executed": "warning",
  "transfer.paid_not_executed_overdue": "blocking",
  // Operations and FBR withholding (spec S-03 §8, migration 0021; rules in tax.reconcile())
  "rent.wht_mismatch": "blocking",
  "rent.statement_totals": "blocking",
  "tax.line_arithmetic": "blocking",
  "tax.payable_mismatch": "blocking",
  // Warning only: freezing payouts would not make the remittance happen sooner (due date LEGAL/TAX TO CONFIRM).
  "tax.wht_unremitted": "warning",
  // Exit, redemption and closure (spec S-05 section 7 and 14.3, migration 0027)
  "exit.ref_id_mismatch": "blocking",
  "exit.burn_before_payment": "blocking",
  // Warning while Redeeming; reported as blocking once the redemption is older than its SLA.
  "exit.supply_not_zero": "warning",
  "exit.waterfall_mismatch": "blocking",
  "exit.register_mismatch": "blocking",
  "exit.statement_totals": "blocking",
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

export interface PayoutBatch {
  reference: string;
  kind: "distribution" | "follow_up";
  /** The distribution batch a follow-up pays held shares of. */
  parentReference: string | null;
  token: string;
  distributionId: bigint;
  /** Paid + held (for a follow-up: what it pays). */
  totalPaisa: bigint;
  paidPaisa: bigint;
  /** 0x-prefixed SHA-256 of the bank file. */
  fileSha256: string;
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

/** One subscription of an S-02 offering (migration 0015, view offering.recon_subscriptions). */
export interface OfferingSubscription {
  subscriptionId: string;
  /** The offering's token (null before L4). Ledger journals are shared by all tokens. */
  token: string | null;
  refId: string;
  offeringId: string;
  offeringState: string;
  hardCap: bigint;
  /** When the offering's mint commands were enqueued (completion); null before. */
  mintStartedAt: Date | null;
  failedAt: Date | null;
  state: string;
  units: bigint;
  wallet: string | null;
  amountPaisa: bigint;
}

export interface OfferingData {
  /**
   * Subscriptions of EVERY offering: the ledger's `sub:*` journals belong to all tokens, so the
   * paid -> minted SLA needs every offering's mint window. The offering checks use this token's only.
   */
  subscriptions: OfferingSubscription[];
  /** OF-53: refunds of a failed offering are due within this time after the failure. */
  refundSlaMs: number;
  /** IssuanceGuard trustee cap in the read model at the pinned block. */
  trusteeCap: bigint;
  /** Matched credits that reached a subscription no longer waiting for them (offering.payment_anomalies). */
  paymentAnomalies: { subscriptionId: string; raastRef: string; state: string }[];
}

/** A RecoveryGuard request in the read model (chain.recoveries). */
export interface ChainRecoveryRequest {
  id: bigint;
  kind: "wallet_recovery" | "forced_transfer";
  status: "pending" | "executed" | "cancelled";
  from: string;
  to: string;
  amount: bigint;
}

/** S-06 data (migration 0020): absent where the recovery schema does not exist (then no recovery checks run). */
export interface RecoveryData {
  /** This deployment's RecoveryGuard requests at the pinned block. */
  requests: ChainRecoveryRequest[];
  /** On-chain request ids that are a recovery case's proposals (recovery.recon_requests). */
  caseRequestIds: bigint[];
  /** Closed reversal cases: the reversed journal and its correcting journal (recovery.recon_reversals). */
  reversals: { caseId: bigint; journalId: bigint; reversalJournalId: bigint }[];
}

/** S-04 phase 0 transfers of this token (migration 0028); absent where it is not applied. */
export interface TransferData {
  /** Rows of transfer.reconcile(token): the rules, evaluated in the database. */
  findings: { check: string; subject: string; expected: string; actual: string }[];
  /** On-chain request ids that are a transfer case's ForcedTransfer (transfer.recon_requests): not S-06 cases. */
  caseRequestIds: bigint[];
}

/** S-03 operations and tax of this token (migration 0021); absent where it is not applied. */
export interface TaxData {
  /** Rows of tax.reconcile(token): the consistency rules, evaluated in the database. */
  findings: { check: string; subject: string; expected: string; actual: string }[];
  /** Calculations with an attached statement, re-verified here independently (keccak, Merkle root, totals). */
  documents: { id: string; status: string; onchainId: bigint | null; statement: string; statementHash: string; schedule: string; scheduleHash: string; root: string }[];
}

/** One line of an exit redemption batch of this token (view exit.recon_lines, migration 0027). */
export interface ExitLine {
  caseId: bigint;
  caseState: string;
  redemptionStatus: string;
  burnRule: "after_payment" | "after_finalization";
  /** The final distribution's on-chain id (null before it was seen on chain). */
  distributionId: bigint | null;
  wallet: string;
  units: bigint;
  refId: string;
  /** exit.line_payment: nothing_to_pay | paid | in_payment | held | returned | unpaid. */
  payment: string;
  released: boolean;
}

/** S-05 exit data of this token (migration 0027); absent where it is not applied (then no exit checks run). */
export interface ExitData {
  lines: ExitLine[];
  cases: { caseId: bigint; state: string; redeemingAt: Date | null; finalBooked: boolean; poolBalance: bigint; closureReserve: bigint; registerUnits: bigint }[];
  /** Final distributions with an attached statement, re-verified here (as the S-03 calculations). */
  finals: { id: string; status: string; onchainId: bigint | null; statement: string; statementHash: string; schedule: string; scheduleHash: string; root: string }[];
  /** exit.supply_not_zero turns blocking this long after Redeeming started. */
  redeemingSlaMs: number;
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
  /** S-02 offerings of this token; absent where migration 0015 is not applied (then no offering checks run). */
  offerings?: OfferingData;
  /** S-06 recovery cases and reversals; absent where migration 0020 is not applied. */
  recovery?: RecoveryData;
  /** S-03 operations and FBR withholding of this token; absent where migration 0021 is not applied. */
  tax?: TaxData;
  /** S-04 phase 0 transfers of this token; absent where migration 0028 is not applied. */
  transfers?: TransferData;
  /** S-05 exits of this token; absent where migration 0027 is not applied. */
  exit?: ExitData;
  bank: {
    accounts: BankAccount[];
    statements: BankStatement[];
    /**
     * Payout batches submitted through the bank service (ADR 0009). A distribution paid through
     * such a batch must carry its file hash on chain, and paid + held must equal its total.
     */
    payoutBatches: PayoutBatch[];
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
