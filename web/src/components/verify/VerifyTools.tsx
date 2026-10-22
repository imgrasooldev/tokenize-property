"use client";

import { useEffect, useState, useTransition, type SubmitEvent } from "react";
import { keccak256, type Hex } from "viem";
import { checkProofOnChain, type ChainProofResult } from "@/app/actions/verify";
import { computeCommitment } from "@/lib/anchor-commitment";
import type { Lang } from "@/lib/i18n";
import { docTypeLabel, fill, type VerifyDict } from "@/lib/i18n-verify";
import { parseEntitlement, verifyEntitlementProof } from "@/lib/merkle";
import { matchDocument, MAX_HASH_BYTES, sha256Hex, type DocumentMatch, type PublicDocument } from "@/lib/verify-rules";
import type { PublicAnchor } from "@/lib/server/anchors";
import type { PublicDistribution } from "@/lib/server/verify";

/**
 * Browser-side checks of the public verification page (S-07). Everything here runs locally: files
 * are hashed with Web Crypto and never uploaded (PV-11), anchor commitments and Merkle proofs are
 * recomputed in the browser (PV-21, PV-31). The only request is the optional on-chain proof check,
 * which sends the pasted entitlement, never a file.
 */

function Tick({ ok, l }: { ok: boolean; l: VerifyDict }) {
  return (
    <span className={`chip ${ok ? "green" : "red"}`} aria-label={ok ? l.ok : l.mismatch}>
      {ok ? "✓" : "✗"}
    </span>
  );
}

const short = (h: string) => (h.length > 20 ? `${h.slice(0, 10)}…${h.slice(-8)}` : h);

// ---------------------------------------------------------------- PV-11 file hash

export function FileHashCheck({ docs, l, lang }: { docs: PublicDocument[]; l: VerifyDict; lang: Lang }) {
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "hashing" } | { kind: "error"; msg: string } | { kind: "done"; hash: string; match: DocumentMatch }
  >({ kind: "idle" });

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_HASH_BYTES) {
      setState({ kind: "error", msg: l.fileTooBig });
      return;
    }
    setState({ kind: "hashing" });
    try {
      const hash = await sha256Hex(await file.arrayBuffer());
      setState({ kind: "done", hash, match: matchDocument(hash, docs) });
    } catch {
      setState({ kind: "error", msg: l.fileError });
    }
  }

  const typeOf = (d: PublicDocument) => docTypeLabel(lang, d.docType);
  return (
    <div className="vcheck" id="file-check">
      <h3>{l.fileTitle}</h3>
      <p className="note">{l.fileNote}</p>
      <label className="filepick">
        <span>{l.fileLabel}</span>
        <input
          type="file"
          onChange={(e) => {
            void onFile(e.currentTarget.files?.[0]);
          }}
        />
      </label>
      <div role="status" aria-live="polite" className="vresult">
        {state.kind === "hashing" && <p className="note">{l.fileHashing}</p>}
        {state.kind === "error" && <p className="alert">{state.msg}</p>}
        {state.kind === "done" && (
          <>
            <p className="fine">
              {l.fileHash}: <span className="mono cy" data-testid="file-hash">{state.hash}</span>
            </p>
            {state.match.kind === "current" && (
              <p className="alert ok" data-result="current">
                ✓ {fill(l.fileCurrent, { n: state.match.doc.id, t: typeOf(state.match.doc) })}
              </p>
            )}
            {state.match.kind === "superseded" && (
              <p className="alert demo" data-result="superseded">
                {fill(l.fileSuperseded, { n: state.match.doc.id, t: typeOf(state.match.doc), c: state.match.doc.supersededBy ?? "?" })}
              </p>
            )}
            {state.match.kind === "none" && (
              <p className="alert" data-result="none">
                ✗ {l.fileNone}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- PV-20/21 anchors

function recompute(a: PublicAnchor): Hex | null {
  try {
    return computeCommitment({
      besuChainId: BigInt(a.besuChainId),
      besuBlock: BigInt(a.besuBlock),
      besuBlockHash: a.besuBlockHash,
      ledgerJournalId: BigInt(a.ledgerJournalId),
      ledgerHeadHash: a.ledgerHeadHash,
    });
  } catch {
    return null;
  }
}

export function AnchorList({ anchors, l }: { anchors: PublicAnchor[]; l: VerifyDict }) {
  // Computed after hydration, so the browser (not the server's HTML) produces the value.
  const [mine, setMine] = useState<(Hex | null)[] | null>(null);
  useEffect(() => {
    setMine(anchors.map(recompute));
  }, [anchors]);
  const statusLabel = { confirmed: l.statusConfirmed, sent: l.statusSent, recorded: l.statusRecorded } as const;
  return (
    <div className="glass table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{l.besuBlock}</th>
            <th>{l.components}</th>
            <th>{l.anchorCommitment}</th>
            <th>{l.recomputed}</th>
            <th>{l.publicValue}</th>
          </tr>
        </thead>
        <tbody>
          {anchors.map((a, i) => {
            const c = mine?.at(i);
            const pub = a.publicValue;
            return (
              <tr key={a.id} data-anchor={a.besuBlock}>
                <td className="mono">
                  #{a.besuBlock}
                  <div className="di small">{statusLabel[a.status]}</div>
                  {a.anchorBlock !== null && <div className="di small">{fill(l.anchorBlockShort, { n: a.anchorBlock })}</div>}
                </td>
                <td className="mono small">
                  <div>besuChainId {a.besuChainId}</div>
                  <div>besuBlockHash {short(a.besuBlockHash)}</div>
                  <div>ledgerJournalId {a.ledgerJournalId}</div>
                  <div>ledgerHeadHash {short(a.ledgerHeadHash)}</div>
                </td>
                <td className="mono small cy" title={a.recorded} data-commitment={a.recorded}>
                  {short(a.recorded)}
                  {a.txHash && (
                    <div className="di" title={a.txHash}>
                      tx {short(a.txHash)}
                    </div>
                  )}
                </td>
                <td className="mono small">
                  {mine === null ? l.computing : c ? short(c) : "—"}
                  {c && (
                    <div className="di">
                      {l.recordedValue}: <Tick ok={c === a.recorded} l={l} />
                    </div>
                  )}
                </td>
                <td className="mono small">
                  {pub === null ? l.notAvailable : short(pub)} {c && pub !== null && <Tick ok={c === pub} l={l} />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const DEC = /^[0-9]{1,20}$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

type SelfFields = Record<"besuChainId" | "besuBlock" | "besuBlockHash" | "ledgerJournalId" | "ledgerHeadHash" | "publicValue", string>;
const EMPTY_FIELDS: SelfFields = { besuChainId: "", besuBlock: "", besuBlockHash: "", ledgerJournalId: "", ledgerHeadHash: "", publicValue: "" };

/**
 * PV-21 by hand: the visitor picks a listed anchor (its components and the anchor-chain value are
 * filled in, every field stays editable) or types everything; the browser recomputes and compares.
 */
export function AnchorSelfCheck({ l, anchors = [] }: { l: VerifyDict; anchors?: PublicAnchor[] }) {
  const [out, setOut] = useState<{ kind: "ok" | "bad"; value: Hex; vsRecorded: boolean } | { kind: "error"; msg: string } | null>(null);
  const [form, setForm] = useState<SelfFields>(EMPTY_FIELDS);
  const [picked, setPicked] = useState("");
  const pickedAnchor = anchors.find((a) => a.id === picked);
  const noPublic = (a: PublicAnchor) => a.publicValue === null || /^0x0{64}$/.test(a.publicValue);

  function pick(id: string) {
    setPicked(id);
    setOut(null);
    const a = anchors.find((x) => x.id === id);
    if (!a) return;
    // The anchor chain's value when this server could read it, otherwise the recorded commitment (said so).
    const pub = a.publicValue !== null && !noPublic(a) ? a.publicValue : a.recorded;
    setForm({ besuChainId: a.besuChainId, besuBlock: a.besuBlock, besuBlockHash: a.besuBlockHash, ledgerJournalId: a.ledgerJournalId, ledgerHeadHash: a.ledgerHeadHash, publicValue: pub });
  }

  const input = (name: keyof SelfFields, value: string, extra: { className?: string; inputMode?: "numeric" } = {}) => (
    <input
      name={name}
      value={value}
      onChange={(e) => {
        const value = e.currentTarget.value;
        setForm((f) => ({ ...f, [name]: value }));
      }}
      autoComplete="off"
      spellCheck={false}
      {...extra}
    />
  );

  function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    check({
      chainId: form.besuChainId.trim(),
      block: form.besuBlock.trim(),
      blockHash: form.besuBlockHash.trim(),
      journal: form.ledgerJournalId.trim(),
      head: form.ledgerHeadHash.trim(),
      pub: form.publicValue.trim(),
    });
  }

  function check(fields: { chainId: string; block: string; blockHash: string; journal: string; head: string; pub: string }) {
    if (!DEC.test(fields.chainId) || !DEC.test(fields.block) || !DEC.test(fields.journal)) {
      setOut({ kind: "error", msg: "besuChainId, besuBlock, ledgerJournalId" });
      return;
    }
    if (!HEX32.test(fields.blockHash) || !HEX32.test(fields.head) || !HEX32.test(fields.pub)) {
      setOut({ kind: "error", msg: "0x + 64 hex" });
      return;
    }
    try {
      const value = computeCommitment({
        besuChainId: BigInt(fields.chainId),
        besuBlock: BigInt(fields.block),
        besuBlockHash: fields.blockHash as Hex,
        ledgerJournalId: BigInt(fields.journal),
        ledgerHeadHash: fields.head as Hex,
      });
      // Compared with the recorded commitment (filled in because the anchor chain was unreadable), not the chain.
      const vsRecorded = pickedAnchor !== undefined && noPublic(pickedAnchor) && fields.pub.toLowerCase() === pickedAnchor.recorded.toLowerCase();
      setOut({ kind: value === fields.pub.toLowerCase() ? "ok" : "bad", value, vsRecorded });
    } catch (err) {
      setOut({ kind: "error", msg: err instanceof Error ? err.message : "?" });
    }
  }
  return (
    <form className="form vcheck" onSubmit={onSubmit} id="anchor-check">
      <h3>{l.selfTitle}</h3>
      <p className="note">{l.selfNote}</p>
      {anchors.length > 0 && (
        <label className="vpick">
          {l.selfPick}
          <select
            name="pick"
            value={picked}
            onChange={(e) => {
              pick(e.currentTarget.value);
            }}
          >
            <option value="">{l.selfPickManual}</option>
            {anchors.map((a) => (
              <option key={a.id} value={a.id}>
                {fill(l.selfPickOption, { n: a.besuBlock })}
              </option>
            ))}
          </select>
        </label>
      )}
      {pickedAnchor && noPublic(pickedAnchor) && (
        <p className="note" data-testid="self-no-public">
          {fill(l.selfPickNoPublic, { n: pickedAnchor.besuBlock })}
        </p>
      )}
      <div className="vgrid">
        <label>
          {l.selfChainId}
          {input("besuChainId", form.besuChainId, { inputMode: "numeric" })}
        </label>
        <label>
          {l.selfBlock}
          {input("besuBlock", form.besuBlock, { inputMode: "numeric" })}
        </label>
        <label>
          {l.selfJournal}
          {input("ledgerJournalId", form.ledgerJournalId, { inputMode: "numeric" })}
        </label>
        <label>
          {l.selfBlockHash}
          {input("besuBlockHash", form.besuBlockHash, { className: "mono" })}
        </label>
        <label>
          {l.selfHead}
          {input("ledgerHeadHash", form.ledgerHeadHash, { className: "mono" })}
        </label>
        <label>
          {l.selfPublic}
          {input("publicValue", form.publicValue, { className: "mono" })}
        </label>
      </div>
      <button type="submit" className="btn secondary small">
        {l.selfCheck}
      </button>
      <div role="status" aria-live="polite" className="vresult">
        {out?.kind === "error" && <p className="alert">{fill(l.selfInvalid, { t: out.msg })}</p>}
        {out && out.kind !== "error" && (
          <>
            <p className="fine">
              {l.recomputed}: <span className="mono cy">{out.value}</span>
            </p>
            <p className={`alert ${out.kind === "ok" ? (out.vsRecorded ? "demo" : "ok") : ""}`} data-result={out.kind === "ok" ? "match" : "mismatch"}>
              {out.kind === "ok" ? `✓ ${out.vsRecorded ? l.selfMatchRecorded : l.selfMatch}` : `✗ ${out.vsRecorded ? l.selfMismatchRecorded : l.selfMismatch}`}
            </p>
          </>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- PV-31 entitlement proof

type ProofState =
  | { kind: "error"; msg: string }
  | { kind: "done"; id: string; local: boolean; localControl: boolean; rejected: boolean; chain: ChainProofResult | null; checking: boolean };

export function ProofCheck({ distributions, l }: { distributions: PublicDistribution[]; l: VerifyDict }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<ProofState | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const ent = parseEntitlement(text);
    if (!ent) {
      setState({ kind: "error", msg: l.proofBadInput });
      return;
    }
    const id = ent.distributionId.toString();
    const dist = distributions.find((d) => d.id === id);
    if (!dist) {
      setState({ kind: "error", msg: fill(l.proofUnknown, { n: id }) });
      return;
    }
    // In the browser first: leaf, root and the 1-paisa control (PV-31).
    const local = verifyEntitlementProof(dist.root, ent.wallet, ent.amountPaisa, ent.proof);
    const localControl = !verifyEntitlementProof(dist.root, ent.wallet, ent.amountPaisa + 1n, ent.proof);
    setState({ kind: "done", id, local, localControl, rejected: dist.status === "rejected", chain: null, checking: true });
    startTransition(async () => {
      const chain = await checkProofOnChain(text);
      setState((s) => (s?.kind === "done" && s.id === id ? { ...s, chain, checking: false } : s));
    });
  }

  const chain = state?.kind === "done" ? state.chain : null;
  return (
    <form className="form vcheck" onSubmit={onSubmit} id="entitlement">
      <h3>{l.proofTitle}</h3>
      <p className="note">{l.proofNote}</p>
      <label>
        {l.proofLabel}
        <textarea
          name="entitlement"
          className="mono"
          rows={6}
          value={text}
          onChange={(e) => {
            setText(e.currentTarget.value);
          }}
          spellCheck={false}
          autoComplete="off"
          maxLength={20_000}
          placeholder={'{"distributionId":"1","wallet":"0x…","amountPaisa":"…","proof":["0x…"]}'}
        />
      </label>
      <button type="submit" className="btn small" disabled={pending}>
        {pending ? l.proofChecking : l.proofCheck}
      </button>
      <div role="status" aria-live="polite" className="vresult">
        {state?.kind === "error" && <p className="alert">{state.msg}</p>}
        {state?.kind === "done" && (
          <ul className="steps-list" data-testid="proof-result">
            <li data-check="local">
              <Tick ok={state.local} l={l} /> {l.proofLocal}
            </li>
            <li data-check="local-control">
              <Tick ok={state.localControl} l={l} /> {l.proofLocalControl}
            </li>
            {state.checking && <li className="note">{l.proofChecking}</li>}
            {chain?.ok === true && (
              <>
                <li data-check="chain">
                  <Tick ok={chain.valid} l={l} /> {fill(l.proofChain, { n: chain.block })}
                </li>
                <li data-check="chain-control">
                  <Tick ok={chain.controlRejected} l={l} /> {l.proofChainControl}
                </li>
              </>
            )}
            {chain?.ok === false && (
              <li className="note">
                {chain.error === "rate" ? l.proofRate : chain.error === "paused" ? l.proofPaused : chain.error === "input" ? l.proofBadInput : l.proofChainError}
              </li>
            )}
            {state.rejected && <li className="note">{l.proofRejected}</li>}
          </ul>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- PV-32 statement file

export function StatementCheck({ distributions, l }: { distributions: PublicDistribution[]; l: VerifyDict }) {
  const [id, setId] = useState(distributions.at(0)?.id ?? "");
  const [out, setOut] = useState<{ id: string; ok: boolean; hash: Hex } | { error: string } | null>(null);
  async function onFile(file: File | undefined) {
    if (!file) return;
    const d = distributions.find((x) => x.id === id);
    if (!d) return;
    if (file.size > MAX_HASH_BYTES) {
      setOut({ error: l.fileTooBig });
      return;
    }
    try {
      const hash = keccak256(new Uint8Array(await file.arrayBuffer()));
      setOut({ id: d.id, ok: hash === d.statementHash.toLowerCase(), hash });
    } catch {
      setOut({ error: l.fileError });
    }
  }
  return (
    <div className="vcheck" id="statement-check">
      <h3>{l.stmtTitle}</h3>
      <p className="note">{l.stmtNote}</p>
      <div className="form vgrid">
        <label>
          {l.stmtDist}
          <select
            value={id}
            onChange={(e) => {
              setId(e.currentTarget.value);
              setOut(null);
            }}
          >
            {distributions.map((d) => (
              <option key={d.id} value={d.id}>
                #{d.id}
              </option>
            ))}
          </select>
        </label>
        <label className="filepick">
          <span>{l.stmtFile}</span>
          <input
            type="file"
            onChange={(e) => {
              void onFile(e.currentTarget.files?.[0]);
            }}
          />
        </label>
      </div>
      <div role="status" aria-live="polite" className="vresult">
        {out && "error" in out && <p className="alert">{out.error}</p>}
        {out && "hash" in out && (
          <>
            <p className="fine">
              keccak256: <span className="mono cy">{out.hash}</span>
            </p>
            <p className={`alert ${out.ok ? "ok" : ""}`}>{out.ok ? `✓ ${fill(l.stmtMatch, { n: out.id })}` : `✗ ${fill(l.stmtMismatch, { n: out.id })}`}</p>
          </>
        )}
      </div>
    </div>
  );
}
