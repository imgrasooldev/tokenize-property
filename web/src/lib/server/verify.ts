import type { Address, Hex } from "viem";
import { PROPERTIES } from "../properties";
import { docTypeName, indexGate, registerCheck, type IndexGate, type PublicDocument, type RegisterCheck } from "../verify-rules";
import { anchorSection, type AnchorSection } from "./anchors";
import { LOCAL_CHAIN_ID, latestDeployment } from "./chain";
import { db } from "./db";
import { distributionsOfToken, documentsOfToken, indexStatus, liveToken, registerFigures, type DistributionRow } from "./readmodel";

/**
 * Everything the public verification page shows (S-07), from the indexer's read model (ADR 0006,
 * ADR 0010 §1) plus the anchor records. Public data only: no names, no wallets, no balances per
 * holder (PV-3), no reconciliation findings (section 5). Every value is a string or a plain object,
 * so the page can hand it to the browser, which does the checks itself.
 *
 * One shared value per 2 s for all visitors (cacheable reads, S-07 section 4).
 */

export interface PublicDistribution {
  id: string;
  status: DistributionRow["status"];
  recordBlock: string;
  totalPaisa: string;
  root: Hex;
  statementHash: Hex;
  publishedAt: string;
  /** Time of the latest status change (rejected, finalized or paid). */
  updatedAt: string | null;
  payoutBatchHash: Hex | null;
  rejectReason: string | null;
}

export interface PublicToken {
  symbol: string;
  address: Address;
  supply: string;
  cap: string;
  paused: boolean;
  pauseReason: string | null;
  holders: number | null;
  register: SerializedRegisterCheck;
}

export type SerializedRegisterCheck =
  | { kind: "not-published" }
  | { kind: "match"; units: string }
  | { kind: "mismatch"; units: string; supply: string; difference: string };

export type ReconStatus =
  | { state: "no-access" }
  | { state: "unavailable" }
  | { state: "none" }
  | { state: "ok"; status: "passed" | "failed"; finishedAt: string; pinnedBlock: string | null };

export interface VerifyView {
  /** Server time of this view (ISO). */
  at: string;
  index: { gate: IndexGate; block: string | null; blockTime: string | null; updatedAt: string | null };
  chainId: number;
  contracts: { token: Address | null; documents: Address | null; distributions: Address | null };
  /** Null when the read model cannot be shown as current (halted or unavailable). */
  token: PublicToken | null;
  /** Catalogue properties without a token yet (labelled, not hidden). */
  untokenized: string[];
  documents: PublicDocument[] | null;
  distributions: PublicDistribution[] | null;
  anchors: AnchorSection;
  recon: ReconStatus;
}

export function serializeRegister(r: RegisterCheck): SerializedRegisterCheck {
  switch (r.kind) {
    case "not-published":
      return r;
    case "match":
      return { kind: "match", units: r.units.toString() };
    case "mismatch":
      return { kind: "mismatch", units: r.units.toString(), supply: r.supply.toString(), difference: r.difference.toString() };
  }
}

const RECON_TTL_MS = 30_000;
let reconCache: { at: number; value: Promise<ReconStatus> } | null = null;

/**
 * The latest finished reconciliation run: passed or failed with its time, never the findings (they
 * may name investors, S-07 section 5). Read through recon.web_status() (migration 0022 WA-5); on a
 * database without that migration the call is refused (42501 or 42883) and the page says so.
 */
export function latestReconciliation(): Promise<ReconStatus> {
  if (reconCache && Date.now() - reconCache.at < RECON_TTL_MS) return reconCache.value;
  const value = (async (): Promise<ReconStatus> => {
    try {
      const { rows } = await (await db()).query<{ status: "passed" | "failed"; finished_at: Date; pinned_block: string | null }>(
        // Migration 0022 WA-5: the website's narrow read of the latest finished run (never findings).
        "SELECT status, finished_at, pinned_block::text FROM recon.web_status()",
      );
      const r = rows[0];
      return r ? { state: "ok", status: r.status, finishedAt: r.finished_at.toISOString(), pinnedBlock: r.pinned_block } : { state: "none" };
    } catch (e) {
      const code = (e as { code?: string }).code;
      return code === "42501" || code === "42883" || code === "3F000" ? { state: "no-access" } : { state: "unavailable" };
    }
  })();
  reconCache = { at: Date.now(), value };
  return value;
}

/**
 * The trustee's register attestation (PV-2). Its format, frequency and source are open (S-07 Q-2;
 * S-01 needs a `document.add` signer kind to anchor it), so none is published yet and the page says
 * "not published", never green.
 */
function registerAttestation(): null {
  return null;
}

async function buildView(): Promise<VerifyView> {
  const d = latestDeployment();
  const contracts = { token: d?.get("token") ?? null, documents: d?.get("documents") ?? null, distributions: d?.get("distributions") ?? null };
  const live = PROPERTIES.at(0);
  // Every listed property has a token (T-045: sample catalogue entries removed).
  const untokenized: string[] = [];
  const [status, anchors, recon] = await Promise.all([indexStatus(), anchorSection(), latestReconciliation()]);
  const gate = indexGate(status);
  const index = {
    gate,
    block: status ? status.block.toString() : null,
    blockTime: status?.blockTime?.toISOString() ?? null,
    updatedAt: status?.updatedAt.toISOString() ?? null,
  };
  const base = { at: new Date().toISOString(), index, chainId: LOCAL_CHAIN_ID, contracts, untokenized, anchors, recon };
  // Section 6: a halted (or unreadable) read model is never shown as current data.
  if (gate === "halted" || gate === "unavailable" || !live) return { ...base, token: null, documents: null, distributions: null };

  const [token, figures, docs, dists] = await Promise.all([liveToken(live.symbol), registerFigures(), documentsOfToken(), distributionsOfToken(24)]);
  return {
    ...base,
    token: token
      ? {
          symbol: token.symbol,
          address: token.address,
          supply: token.supply.toString(),
          cap: token.cap.toString(),
          paused: token.paused,
          pauseReason: token.pauseReason,
          holders: figures?.holders ?? null,
          register: serializeRegister(registerCheck(token.supply, registerAttestation())),
        }
      : null,
    documents:
      docs?.map((x) => ({
        id: x.id.toString(),
        docType: docTypeName(x.docType),
        sha256: x.sha256,
        uri: x.uri,
        supersededBy: x.supersededBy?.toString() ?? null,
        addedBlock: x.addedBlock.toString(),
        addedAt: x.addedAt?.toISOString() ?? "",
      })) ?? null,
    distributions:
      dists?.map((x) => ({
        id: x.id.toString(),
        status: x.status,
        recordBlock: x.recordBlock.toString(),
        totalPaisa: x.totalPaisa.toString(),
        root: x.root,
        statementHash: x.statementHash,
        publishedAt: x.publishedAt.toISOString(),
        updatedAt: x.status === "published" ? null : (x.updatedAt?.toISOString() ?? null),
        payoutBatchHash: x.payoutBatchHash,
        rejectReason: x.rejectReason,
      })) ?? null,
  };
}

const TTL_MS = 2_000;
let cache: { at: number; value: Promise<VerifyView> } | null = null;

export function verificationView(): Promise<VerifyView> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const value = buildView();
  cache = { at: Date.now(), value };
  void value.catch(() => {
    cache = null; // never cache a failure
  });
  return value;
}
