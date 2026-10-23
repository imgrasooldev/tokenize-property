"use client";

import { useState } from "react";
import type { TransferDict } from "@/lib/i18n-transfer";
import { agreementSha256, shortHex } from "@/lib/transfer-rules";
import { MAX_HASH_BYTES } from "@/lib/verify-rules";

/**
 * The signed transfer agreement: the file is read in the browser and only its SHA-256 is kept (the
 * file input has no name, so the file itself is never uploaded; same approach as /verify). With
 * `expected` (the buyer's acceptance) the page says at once whether it is the seller's document; the
 * database compares again.
 */
export function AgreementFile({ l, id, hash, onHash, expected }: { l: TransferDict; id: string; hash: string; onHash: (h: string) => void; expected?: string }) {
  const [state, setState] = useState<"idle" | "hashing" | "error" | "big">("idle");

  async function onFile(file: File | undefined) {
    onHash("");
    if (!file) return;
    if (file.size > MAX_HASH_BYTES) {
      setState("big");
      return;
    }
    setState("hashing");
    try {
      onHash(await agreementSha256(await file.arrayBuffer()));
      setState("idle");
    } catch {
      setState("error");
    }
  }

  return (
    <div className="filepick">
      <label htmlFor={id}>{l.fileLabel}</label>
      <input
        id={id}
        type="file"
        aria-describedby={`${id}-note`}
        onChange={(e) => {
          void onFile(e.currentTarget.files?.[0]);
        }}
      />
      <span className="hint" id={`${id}-note`}>
        {l.fileNote}
      </span>
      <div role="status" aria-live="polite">
        {state === "hashing" && <p className="note">{l.fileHashing}</p>}
        {state === "error" && <p className="alert">{l.fileError}</p>}
        {state === "big" && <p className="alert">{l.fileTooBig}</p>}
        {hash && (
          <p className="fine">
            {l.fileHash}:{" "}
            <span className="mono cy" dir="ltr" title={hash} data-testid="agreement-hash">
              {shortHex(hash, 12, 10)}
            </span>
          </p>
        )}
        {hash && expected !== undefined && expected !== "" && (
          <p className={hash === expected ? "alert ok" : "alert"} data-testid="agreement-match">
            {hash === expected ? `✓ ${l.fileMatch}` : `✗ ${l.fileMismatch}`}
          </p>
        )}
      </div>
    </div>
  );
}
