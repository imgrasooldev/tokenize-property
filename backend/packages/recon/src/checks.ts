import {
  addDays,
  dayEnd,
  dayStart,
  journalTotal,
  parseRentKey,
  parseSubscriptionKey,
  payoutBatchHash,
  pktDate,
  type SubscriptionPhase,
} from "./conventions.ts";
import {
  CHECKS,
  type BankLine,
  type Severity,
  type ChainIssuance,
  type CheckName,
  type Finding,
  type LedgerJournal,
  type ReconData,
} from "./types.ts";

/**
 * The reconciliation checks. Each one is a pure function of ReconData: no I/O, no clock (ages are
 * measured from data.asOf), output sorted, so the same data always gives the same findings.
 */

/** Read model this many blocks behind the node (10 minutes at 2-second blocks) is worth a warning. */
export const LAG_WARN_BLOCKS = 300n;
/** At most this many findings per check name are listed; the rest are counted in one extra finding. */
export const MAX_PER_CHECK = 500;

type Detail = Finding["detail"];
const SEVERITY = new Map(Object.entries(CHECKS) as [CheckName, Severity][]);

function f(check: CheckName, subject: string, expected?: string, actual?: string, detail?: Detail): Finding {
  return {
    check,
    severity: SEVERITY.get(check) ?? "blocking",
    subject: subject.slice(0, 300),
    ...(expected === undefined ? {} : { expected: expected.slice(0, 500) }),
    ...(actual === undefined ? {} : { actual: actual.slice(0, 500) }),
    ...(detail === undefined ? {} : { detail }),
  };
}

const s = (n: bigint): string => n.toString();
const sum = (xs: Iterable<bigint>): bigint => {
  let t = 0n;
  for (const x of xs) t += x;
  return t;
};

// ------------------------------------------------------------------ tokens and issuance (M-6)

/**
 * Every on-chain mint refId has exactly one paid subscription in the ledger and vice versa; the
 * minted amount and wallet are what the subscription asked for; nothing paid stays unminted, and
 * nothing minted stays unsettled, longer than the SLA; a refund never coexists with a mint.
 */
export function checkIssuance(d: ReconData): Finding[] {
  const out: Finding[] = [];
  const subs = new Map<string, Record<SubscriptionPhase, LedgerJournal[]>>();
  for (const j of d.ledger.journals) {
    const k = parseSubscriptionKey(j.key);
    if (!k) continue;
    const entry = subs.get(k.refId) ?? { paid: [], settled: [], refunded: [] };
    entry[k.phase].push(j);
    subs.set(k.refId, entry);
  }
  const mints = new Map<string, ChainIssuance>();
  const burns: ChainIssuance[] = [];
  for (const i of d.chain.issuances) {
    if (i.kind === "mint") mints.set(i.refId, i);
    else burns.push(i);
  }
  const late = (t: Date): boolean => d.asOf.getTime() - t.getTime() > d.slaMs;
  const minted = (m: ChainIssuance): string => `minted ${s(m.amount)} to ${m.account} at block ${s(m.blockNumber)}`;

  for (const refId of [...new Set([...subs.keys(), ...mints.keys(), ...d.expectedMints.keys()])].sort()) {
    const sub = subs.get(refId);
    const m = mints.get(refId);
    const e = d.expectedMints.get(refId);
    const subject = `refId ${refId}`;
    if (e && e.commands > 1) out.push(f("issuance.duplicate_command", subject, "1 mint command", `${String(e.commands)} mint commands`));
    const paid = sub?.paid[0];
    if (!sub || !paid) {
      if (sub) out.push(f("issuance.unpaid_settlement", subject, "a paid journal before settlement or refund", "settled or refunded without payment"));
      if (m) out.push(f("issuance.orphan_mint", subject, "a paid subscription in the ledger", minted(m), { tx: m.txHash }));
      if (e && !m) out.push(f("issuance.command_without_payment", subject, "a paid subscription in the ledger", `${e.source} mint of ${s(e.amount)} to ${e.to}`));
      continue;
    }
    if (sub.paid.length > 1) out.push(f("issuance.duplicate_payment", subject, "1 paid journal", `${String(sub.paid.length)} paid journals`));
    const amount = journalTotal(paid);
    for (const j of [...sub.settled, ...sub.refunded]) {
      if (journalTotal(j) !== amount) out.push(f("issuance.settlement_mismatch", `${subject} journal ${s(j.id)}`, `${s(amount)} paisa as paid`, `${s(journalTotal(j))} paisa`));
    }
    const settled = sub.settled[0];
    const refunded = sub.refunded[0];
    if (settled && refunded) out.push(f("issuance.settled_and_refunded", subject, "settled or refunded", "both"));
    if (refunded && m) out.push(f("issuance.refunded_but_minted", subject, "no mint after a refund", minted(m), { tx: m.txHash }));
    if (settled && !m && late(settled.createdAt)) out.push(f("issuance.settled_without_mint", subject, "a mint on chain", `none at block ${s(d.pinnedBlock)}`));
    if (!settled && !refunded) {
      if (m && late(m.blockTime)) out.push(f("issuance.minted_not_settled", subject, "settled within the SLA", minted(m), { tx: m.txHash }));
      if (!m && late(paid.createdAt)) out.push(f("issuance.paid_not_minted", subject, "minted or refunded within the SLA", `paid ${paid.createdAt.toISOString()}, no mint at block ${s(d.pinnedBlock)}`));
    }
    if (m) {
      if (!e) out.push(f("issuance.unverified_amount", subject, "the subscription's token amount and wallet", "not known to the ledger, outbox or subscriptions"));
      else {
        if (e.amount !== m.amount) out.push(f("issuance.amount_mismatch", subject, `${s(e.amount)} tokens (${e.source})`, `${s(m.amount)} tokens minted`, { tx: m.txHash }));
        if (e.to !== m.account) out.push(f("issuance.wallet_mismatch", subject, `${e.to} (${e.source})`, `minted to ${m.account}`, { tx: m.txHash }));
      }
    }
  }
  for (const b of burns) {
    out.push(f("issuance.burn_not_reconciled", `refId ${b.refId}`, "a redemption in the ledger (no convention yet)", `burned ${s(b.amount)} from ${b.account} at block ${s(b.blockNumber)}`, { tx: b.txHash }));
  }
  return out;
}

// ------------------------------------------------------------------ supply and holdings at the pinned block

/** totalSupply agrees between the contract, the read model, the sum of holdings and mints minus burns. */
export function checkSupply(d: ReconData): Finding[] {
  const out: Finding[] = [];
  const at = `token ${d.deployment.token} at block ${s(d.pinnedBlock)}`;
  const rm = d.chain.readModel.totalSupply;
  const oc = d.chain.onChain.totalSupply;
  if (rm !== oc) out.push(f("supply.chain_vs_read_model", at, `${s(oc)} (totalSupply on chain)`, `${s(rm)} (read model)`));
  const held = sum(d.chain.readModel.holdings.values());
  if (held !== rm) out.push(f("supply.holdings_sum", at, `${s(rm)} (read model supply)`, `${s(held)} (sum of read-model holdings)`));
  let net = 0n;
  for (const i of d.chain.issuances) net += i.kind === "mint" ? i.amount : -i.amount;
  if (net !== oc) out.push(f("supply.issuance_net", at, `${s(oc)} (totalSupply on chain)`, `${s(net)} (IssuanceGuard mints minus burns)`));
  return out;
}

/** Every read-model balance equals balanceOf on chain; the known holders account for the whole supply. */
export function checkHoldings(d: ReconData): Finding[] {
  const out: Finding[] = [];
  const holders = [...new Set([...d.chain.readModel.holdings.keys(), ...d.chain.onChain.balances.keys()])].sort();
  for (const h of holders) {
    const rm = d.chain.readModel.holdings.get(h) ?? 0n;
    const oc = d.chain.onChain.balances.get(h) ?? 0n;
    if (rm !== oc) out.push(f("holdings.balance_mismatch", `holder ${h} at block ${s(d.pinnedBlock)}`, `${s(oc)} (balanceOf on chain)`, `${s(rm)} (read model)`));
  }
  const known = sum(d.chain.onChain.balances.values());
  if (known !== d.chain.onChain.totalSupply) {
    out.push(f("holdings.missing_holder", `token ${d.deployment.token} at block ${s(d.pinnedBlock)}`, `${s(d.chain.onChain.totalSupply)} (totalSupply)`, `${s(known)} (balances of the read model's holders)`));
  }
  return out;
}

// ------------------------------------------------------------------ cash: ledger vs bank

/**
 * For every registered bank account: statements are consecutive and chain (opening = previous
 * closing); the ledger balance equals the bank's opening and every day's closing (PKT day cut-off);
 * every bank line matches exactly one ledger posting with the same reference, direction and amount,
 * and vice versa, over the period the statements cover.
 */
export function checkCash(d: ReconData): Finding[] {
  const out: Finding[] = [];
  if (d.bank.accounts.length === 0) {
    out.push(f("cash.not_configured", "bank statements", "a registered bank account with imported statements", "none registered: cash is not reconciled"));
    return out;
  }
  const today = pktDate(d.asOf);
  for (const acct of [...d.bank.accounts].sort((a, b) => a.account.localeCompare(b.account))) {
    const stmts = d.bank.statements.filter((x) => x.account === acct.account).sort((a, b) => a.date.localeCompare(b.date));
    const first = stmts[0];
    const last = stmts.at(-1);
    if (!first || !last) {
      out.push(f("cash.no_statement", `bank account ${acct.account}`, "an imported statement", "none"));
      continue;
    }
    const postings = d.ledger.journals.flatMap((j) => j.postings.filter((p) => p.account === acct.ledgerAccount).map((p) => ({ j, amount: p.amount })));
    const balanceBefore = (t: Date): bigint => sum(postings.filter((p) => p.j.createdAt < t).map((p) => p.amount));

    const opening = balanceBefore(dayStart(first.date));
    if (opening !== first.opening) out.push(f("cash.opening_mismatch", `${acct.account} ${first.date}`, `${s(first.opening)} (bank opening)`, `${s(opening)} (ledger ${acct.ledgerAccount})`));
    stmts.forEach((st, i) => {
      const prev = stmts[i - 1];
      if (prev && st.date !== addDays(prev.date, 1)) out.push(f("cash.statement_gap", `${acct.account} after ${prev.date}`, `statement for ${addDays(prev.date, 1)}`, `next statement is ${st.date}`));
      if (prev && st.opening !== prev.closing) out.push(f("cash.statement_gap", `${acct.account} ${st.date}`, `opening ${s(prev.closing)} (previous closing)`, `opening ${s(st.opening)}`));
      const closing = balanceBefore(dayEnd(st.date));
      if (closing !== st.closing) out.push(f("cash.closing_mismatch", `${acct.account} ${st.date}`, `${s(st.closing)} (bank closing)`, `${s(closing)} (ledger ${acct.ledgerAccount})`));
    });
    if (last.date < addDays(today, -1)) out.push(f("cash.statement_stale", `bank account ${acct.account}`, `a statement for ${addDays(today, -1)} or later`, `latest is ${last.date}`));

    const from = dayStart(first.date);
    const to = dayEnd(last.date);
    const key = (ref: string, amount: bigint): string => `${ref}|${amount > 0n ? "in" : "out"}`;
    const bank = new Map<string, BankLine[]>();
    for (const st of stmts) for (const l of st.lines) bank.set(key(l.reference, l.amount), [...(bank.get(key(l.reference, l.amount)) ?? []), l]);
    const ledger = new Map<string, { j: LedgerJournal; amount: bigint }[]>();
    for (const p of postings) {
      if (p.j.createdAt < from || p.j.createdAt >= to) continue;
      if (!p.j.externalRef) {
        out.push(f("cash.unmatched_ledger_entry", `journal ${s(p.j.id)} (${p.j.key})`, "a bank reference", `${s(p.amount)} on ${acct.ledgerAccount} without a reference`));
        continue;
      }
      const k = key(p.j.externalRef, p.amount);
      ledger.set(k, [...(ledger.get(k) ?? []), p]);
    }
    for (const k of [...new Set([...bank.keys(), ...ledger.keys()])].sort()) {
      const b = bank.get(k) ?? [];
      const l = ledger.get(k) ?? [];
      const subject = `${acct.account} ${k.replace("|", " ")}`;
      if (b.length > 1) out.push(f("cash.duplicate_bank_line", subject, "1 bank line", `${String(b.length)} bank lines`));
      if (l.length > 1) out.push(f("cash.duplicate_ledger_entry", subject, "1 ledger entry", `${String(l.length)} ledger entries (journals ${l.map((x) => s(x.j.id)).join(", ")})`));
      const bl = b[0];
      const ll = l[0];
      if (!bl && ll) out.push(f("cash.unmatched_ledger_entry", subject, "a bank line", `journal ${s(ll.j.id)} (${ll.j.key}) ${s(ll.amount)} paisa`));
      if (bl && !ll) out.push(f("cash.unmatched_bank_line", subject, "a ledger entry", `bank line ${String(bl.lineNo)} on ${bl.valueDate}: ${s(bl.amount)} paisa`));
      if (bl && ll && bl.amount !== ll.amount) out.push(f("cash.amount_mismatch", subject, `${s(bl.amount)} paisa (bank)`, `${s(ll.amount)} paisa (ledger journal ${s(ll.j.id)})`));
    }
  }
  return out;
}

// ------------------------------------------------------------------ rent (M-2)

/**
 * Each on-chain distribution (total, statement hash, status, payout batch hash) agrees with the
 * ledger's rent journals: booked once finalized, never when rejected, paid out exactly as recorded
 * on chain. The bank side of the payout batch is matched by checkCash (same reference).
 */
export function checkRent(d: ReconData): Finding[] {
  const out: Finding[] = [];
  const ours = d.deployment.token;
  const chain = new Map(d.chain.distributions.filter((x) => x.token === ours).map((x) => [x.id, x]));
  const booked = new Map<bigint, LedgerJournal>();
  const paidOut = new Map<bigint, LedgerJournal>();
  for (const j of d.ledger.journals) {
    const k = parseRentKey(j.key);
    if (!k || k.token !== ours) continue;
    (k.what === "distribution" ? booked : paidOut).set(k.id, j);
  }
  for (const id of [...new Set([...chain.keys(), ...booked.keys(), ...paidOut.keys()])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const c = chain.get(id);
    const dj = booked.get(id);
    const pj = paidOut.get(id);
    const subject = `distribution ${s(id)}`;
    if (!c) {
      out.push(f("rent.orphan_ledger", subject, `distribution on chain at block ${s(d.pinnedBlock)}`, `ledger ${[dj?.key, pj?.key].filter(Boolean).join(", ")}`));
      continue;
    }
    if (c.status === "rejected" && dj) out.push(f("rent.booked_after_reject", subject, "no rent booking for a rejected distribution", `journal ${s(dj.id)}`));
    if ((c.status === "rejected" || c.status === "published") && pj) out.push(f("rent.payout_premature", subject, "payout only after finalization", `journal ${s(pj.id)} while ${c.status}`));
    if ((c.status === "finalized" || c.status === "paid") && !dj) out.push(f("rent.missing_ledger", subject, `rent booked for ${s(c.totalPaisa)} paisa`, `no ledger journal while ${c.status}`));
    if (dj) {
      if ((dj.externalRef ?? "").toLowerCase() !== c.statementHash) out.push(f("rent.statement_hash_mismatch", subject, `${c.statementHash} (on chain)`, `${dj.externalRef ?? "none"} (ledger)`));
      if (journalTotal(dj) !== c.totalPaisa) out.push(f("rent.total_mismatch", subject, `${s(c.totalPaisa)} paisa (on chain)`, `${s(journalTotal(dj))} paisa (ledger)`));
    }
    if (c.status === "paid") {
      if (!pj) out.push(f("rent.payout_missing", subject, "a payout batch in the ledger", "none"));
      else {
        // A batch submitted through the bank service is identified by its bank file's SHA-256 (ADR 0009);
        // otherwise (web prototype, mock) by keccak256 of the batch reference (ADR 0007).
        const file = d.bank.payoutFiles.get(pj.externalRef ?? "");
        const h = file ?? payoutBatchHash(pj.externalRef ?? "");
        if (h !== c.payoutBatchHash) {
          out.push(f("rent.payout_batch_mismatch", subject, `${c.payoutBatchHash ?? "none"} (on chain)`, `${h} = ${file ? "SHA-256 of the bank file" : "hash"} of batch ${pj.externalRef ?? "none"}`));
        }
        if (journalTotal(pj) !== c.totalPaisa) out.push(f("rent.payout_amount_mismatch", subject, `${s(c.totalPaisa)} paisa (on chain)`, `${s(journalTotal(pj))} paisa paid out (ledger)`));
      }
    } else if (c.status === "finalized" && pj) {
      out.push(f("rent.payout_not_recorded", subject, "recordPayout on chain", `ledger payout journal ${s(pj.id)}, chain still finalized`));
    }
  }
  return out;
}

// ------------------------------------------------------------------ integrity

/**
 * The records themselves: ledger hash chain, signer and recon audit chains, the indexer (halted,
 * verify mismatch = blocking per ADR 0006, lag), and outbox commands stuck beyond the SLA.
 */
export function checkIntegrity(d: ReconData): Finding[] {
  const out: Finding[] = [];
  const i = d.integrity;
  for (const p of i.ledger) out.push(f("integrity.ledger_chain", `journal ${p.journalId}`, "intact hash chain", p.problem));
  for (const b of i.ledgerBalances) {
    out.push(f("integrity.ledger_balances", `ledger account ${b.code}`, `running balance = sum of postings (${b.actual})`, `running balance ${b.cached ?? "missing"}`));
  }
  for (const p of i.signerAudit) out.push(f("integrity.signer_audit", `signer audit ${p.auditId}`, "intact hash chain", p.problem));
  for (const p of i.reconAudit) out.push(f("integrity.recon_audit", `recon audit ${p.auditId ?? "-"}`, "intact hash chain", p.problem));
  if (i.indexer.halted) out.push(f("integrity.indexer_halted", `deployment ${d.deployment.id}`, "indexer following the chain", i.indexer.halted));
  if (i.indexer.verify.ran) {
    for (const p of i.indexer.verify.problems) {
      out.push(f("integrity.indexer_verify", `read model at block ${s(i.indexer.verify.pinnedBlock ?? -1n)}`, "read model = rebuild from the chain = contract state", p));
    }
  }
  if (i.indexer.lagBlocks !== null && i.indexer.lagBlocks > LAG_WARN_BLOCKS) {
    out.push(f("integrity.indexer_lag", `deployment ${d.deployment.id}`, `at most ${s(LAG_WARN_BLOCKS)} blocks behind`, `${s(i.indexer.lagBlocks)} blocks behind`));
  }
  for (const c of i.outbox) {
    const age = d.asOf.getTime() - c.updatedAt.getTime();
    if (age <= d.slaMs) continue;
    const check = c.status === "submitted" || c.status === "review" ? "integrity.outbox_stuck" : "integrity.outbox_waiting";
    out.push(f(check, `outbox command ${s(c.id)} (${c.kind})`, `settled within ${String(Math.round(d.slaMs / 60_000))} min`,
      `${c.status} for ${String(Math.round(age / 60_000))} min${c.lastError ? `: ${c.lastError}` : ""}`));
  }
  return out;
}

export const ALL_CHECKS = [checkIssuance, checkSupply, checkHoldings, checkCash, checkRent, checkIntegrity] as const;

/** Runs every check; findings sorted by check and subject, at most MAX_PER_CHECK listed per check. */
export function runChecks(d: ReconData): Finding[] {
  const all = ALL_CHECKS.flatMap((check) => check(d));
  all.sort((a, b) => (a.check === b.check ? a.subject.localeCompare(b.subject) : a.check.localeCompare(b.check)));
  const out: Finding[] = [];
  const counts = new Map<CheckName, number>();
  for (const x of all) {
    const n = (counts.get(x.check) ?? 0) + 1;
    counts.set(x.check, n);
    if (n <= MAX_PER_CHECK) out.push(x);
  }
  for (const [check, n] of counts) {
    if (n > MAX_PER_CHECK) out.push(f(check, `(${String(n - MAX_PER_CHECK)} more not listed)`, undefined, `${String(n)} findings in total`));
  }
  return out;
}
