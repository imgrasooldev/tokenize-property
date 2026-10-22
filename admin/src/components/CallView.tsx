import type { SignerPreview } from "@/lib/server/signer";

/**
 * The exact call a signing request will sign, decoded from the calldata the signing service builds
 * (Step 6b preview), with its call hash and the policy rules. Shared by the trustee co-signing page.
 */
export function CallView({ preview, unreachable, approvalsNeeded }: { preview: SignerPreview | null; unreachable: string | null; approvalsNeeded: number }) {
  const call = preview?.call ?? null;
  return (
    <section className="card" aria-labelledby="sign">
      <h2 id="sign">
        Exactly what will be signed <span className="sp" />
        {preview?.live ? (
          <span
            className={preview.live.state === "pass" ? "chip ok" : preview.live.state === "fail" ? "chip bad" : "chip"}
            data-testid="live-checks"
            title={preview.live.reason ?? ""}
          >
            {preview.live.state === "pass"
              ? `policy checks pass now · ${String(preview.live.approvalsNeeded ?? approvalsNeeded)} platform approvals`
              : preview.live.state === "fail"
                ? "policy refuses now"
                : preview.live.state === "skipped"
                  ? "checked at signing"
                  : "live checks unavailable"}
          </span>
        ) : null}
      </h2>
      {call ? (
        <>
          <dl className="kv">
            <dt>Contract</dt>
            <dd className="mono">
              {call.contract} · {call.to}
            </dd>
            <dt>Function</dt>
            <dd className="mono" data-testid="call-function">
              {`${call.functionName}(${call.args.map((a) => a.type).join(", ")})`}
            </dd>
            {call.args.map((a) => (
              <div key={a.name} style={{ display: "contents" }}>
                <dt className="mono">{a.name}</dt>
                <dd className="mono" data-testid={`arg-${a.name}`}>
                  {a.value}
                </dd>
              </div>
            ))}
            <dt>From</dt>
            <dd className="mono">{call.from ?? "key not loaded"}</dd>
            <dt>Chain · gas limit</dt>
            <dd className="mono">
              {call.chainId} · {Number(call.gasLimit).toLocaleString("en-PK")} (fixed by policy)
            </dd>
          </dl>
          <div className="diff" style={{ marginBlockStart: 10 }} data-testid="calldata">
            <span className="di">to</span> {call.to}
            <br />
            <span className="di">data</span> {call.data ?? `${call.selector}… (signature made at signing time)`}
            <br />
            <span className="di">call hash</span>{" "}
            <span className="cy" data-testid="call-hash">
              {call.callHash}
            </span>
          </div>
          {call.note ? <p className="small mu">{call.note}</p> : null}
          {preview?.live.state === "fail" || preview?.live.state === "unavailable" ? (
            <p className={preview.live.state === "fail" ? "alert bad" : "alert info"}>{preview.live.reason}</p>
          ) : null}
          <b className="small" style={{ display: "block", marginBlockStart: 10 }}>
            Policy rules (checked again just before signing)
          </b>
          <ul className="checks" style={{ marginBlockStart: 6 }}>
            {call.rules.map((x) => (
              <li key={x}>
                <i aria-hidden="true">✓</i>
                <span className="small">{x}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="alert info" data-testid="signer-unavailable">
          {unreachable ?? preview?.problem ?? "No call to show."}
        </p>
      )}
    </section>
  );
}
