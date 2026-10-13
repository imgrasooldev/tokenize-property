import type { Deployment } from "@pt/indexer";
import type pg from "pg";
import type { ChainState } from "./chain.ts";
import { runChecks } from "./checks.ts";
import { loadData } from "./load.ts";
import { completeRun, failRun, startRun, type RunStatus } from "./store.ts";
import type { Finding } from "./types.ts";

export interface ReconcileOptions {
  deployment: Deployment;
  chain: ChainState;
  /** Who runs it (stored with the run and in the audit log). */
  actor: string;
  /** How long payment -> mint -> settlement and outbox commands may be in flight. Default 30. */
  slaMinutes?: number;
  verifyIndexer: (() => Promise<{ pinnedBlock: bigint; problems: string[] }>) | null;
}

export interface RunReport {
  runId: bigint;
  status: RunStatus;
  pinnedBlock: bigint | null;
  findings: Finding[];
  summary: Record<string, unknown>;
  error?: string;
  ms: number;
}

/**
 * One reconciliation run: start (recorded), load one consistent snapshot pinned to the read
 * model's block, run every check, then record the findings and the result in one transaction.
 * Any blocking finding freezes payouts (in the database, same transaction). A failure to load
 * finishes the run as "error" (payouts stay denied until a run passes) and is rethrown.
 */
export async function reconcile(pool: pg.Pool, o: ReconcileOptions): Promise<RunReport> {
  const started = performance.now();
  const slaMinutes = o.slaMinutes ?? 30;
  const params = { slaMinutes, verifyIndexer: o.verifyIndexer !== null, token: o.deployment.contracts.token };
  const runId = await startRun(pool, o.actor, o.deployment.id, params);
  let loaded;
  try {
    loaded = await loadData(pool, { deployment: o.deployment, chain: o.chain, slaMinutes, verifyIndexer: o.verifyIndexer });
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] ?? "error" : String(err);
    await failRun(pool, runId, o.actor, message);
    return { runId, status: "error", pinnedBlock: null, findings: [], summary: {}, error: message, ms: Math.round(performance.now() - started) };
  }
  const t = performance.now();
  const findings = runChecks(loaded.data);
  const checkMs = Math.round(performance.now() - t);
  const d = loaded.data;
  const summary = {
    pinnedBlock: d.pinnedBlock.toString(),
    asOf: d.asOf.toISOString(),
    counts: {
      issuances: d.chain.issuances.length,
      holders: d.chain.readModel.holdings.size,
      distributions: d.chain.distributions.length,
      journals: d.ledger.journals.length,
      expectedMints: d.expectedMints.size,
      bankAccounts: d.bank.accounts.length,
      statements: d.bank.statements.length,
      bankLines: d.bank.statements.reduce((n, s) => n + s.lines.length, 0),
      openOutboxCommands: d.integrity.outbox.length,
      offeringSubscriptions: d.offerings?.subscriptions.length ?? 0,
    },
    totalSupply: d.chain.onChain.totalSupply.toString(),
    indexerVerify: d.integrity.indexer.verify.ran ? `ran at block ${String(d.integrity.indexer.verify.pinnedBlock)}` : "not run",
    indexerLagBlocks: d.integrity.indexer.lagBlocks?.toString() ?? null,
    sources: loaded.sources,
    timings: { ...loaded.timings, checkMs },
  };
  const status = await completeRun(pool, runId, o.actor, d.pinnedBlock, findings, summary);
  return { runId, status, pinnedBlock: d.pinnedBlock, findings, summary, ms: Math.round(performance.now() - started) };
}

/** Plain-text report for operators. */
export function formatReport(r: RunReport): string {
  const lines: string[] = [];
  const blocking = r.findings.filter((x) => x.severity === "blocking").length;
  const warnings = r.findings.length - blocking;
  lines.push(`Reconciliation run ${r.runId.toString()}: ${r.status.toUpperCase()}` +
    (r.pinnedBlock === null ? "" : ` · pinned block ${r.pinnedBlock.toString()}`) +
    ` · ${String(blocking)} blocking, ${String(warnings)} warning(s) · ${String(r.ms)} ms`);
  if (r.error) lines.push(`  error: ${r.error}`);
  if (r.status === "failed") lines.push("  PAYOUTS ARE FROZEN. Unfreezing needs a passed run and two operators (npm run recon:unfreeze).");
  let current = "";
  for (const x of r.findings) {
    if (x.check !== current) {
      current = x.check;
      lines.push(`  [${x.severity}] ${x.check}`);
    }
    const ea = x.expected !== undefined || x.actual !== undefined ? `: expected ${x.expected ?? "-"}, got ${x.actual ?? "-"}` : "";
    lines.push(`    - ${x.subject}${ea}`);
  }
  return lines.join("\n");
}

/** JSON-safe copy (bigints as strings). */
export function reportJson(r: RunReport): string {
  return JSON.stringify(r, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);
}
