import type { Metadata } from "next";
import { Fragment } from "react";
import { Shell } from "@/components/Shell";
import { age, int, pkt, short, since } from "@/lib/format";
import { chainHealth } from "@/lib/server/chain";
import { opsOverview, type OpsOverview } from "@/lib/server/ops";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Operations overview" };

const LANES = ["pending", "claimed", "submitted", "review", "confirmed", "failed"] as const;

function statusChip(status: string) {
  const cls =
    status === "confirmed" ? "chip ok" : status === "failed" ? "chip bad" : status === "review" ? "chip warn" : status === "pending" ? "chip" : "chip cy";
  return <span className={cls}>{status}</span>;
}

function count(o: OpsOverview, status: string): number {
  return o.outbox.find((x) => x.status === status)?.commands ?? 0;
}

export default async function OverviewPage() {
  const officer = await requirePage("ops.read", "/");
  const t0 = performance.now();
  const [o, chain] = await Promise.all([opsOverview(officer.sessionHash), chainHealth()]);
  const readMs = Math.round(performance.now() - t0);
  const now = Date.parse(o.at);

  const cursor = o.indexer[0] ?? null;
  const halted = o.indexer.some((d) => d.haltedAt !== null);
  const lag = chain.head !== null && cursor ? chain.head - cursor.block : null;
  const backlog = count(o, "pending") + count(o, "claimed") + count(o, "submitted") + count(o, "review");
  const oldestOpen = Math.max(0, ...o.outbox.filter((x) => ["pending", "claimed", "submitted", "review"].includes(x.status)).map((x) => x.oldestSeconds));
  const recentHeads = chain.head ?? 0;
  const liveVals = chain.validators.filter((v) => v.lastProposed !== null && recentHeads - v.lastProposed < 24).length;
  const gate = o.recon.gate;
  const run = o.recon.lastRun;
  const anchor = o.anchor.latest;

  const chainState = !chain.ok ? "Down" : liveVals >= Math.min(chain.validators.length, 3) && chain.validators.length > 0 ? "Healthy" : "Degraded";

  return (
    <Shell
      officer={officer}
      current="/"
      title="Operations overview"
      actions={
        <span className="chip">
          <span className={chain.ok ? "dot" : "dot bad"} aria-hidden="true" />
          Block <b className="mono">#{int(chain.head)}</b>
        </span>
      }
    >
      <section className="kpis" aria-label="Health">
        <div className="kpi">
          <div className="label">Chain (QBFT)</div>
          <div className={`val ${chainState === "Healthy" ? "up" : chainState === "Down" ? "dn" : "am"}`}>{chainState}</div>
          <div className="sub">
            {chain.ok
              ? `${String(liveVals)}/${String(chain.validators.length)} proposing · ${chain.avgBlockSeconds?.toFixed(1) ?? "–"} s`
              : (chain.error ?? "RPC unreachable")}
          </div>
        </div>
        <div className="kpi">
          <div className="label">Indexer lag</div>
          <div className={`val ${halted ? "dn" : lag !== null && lag > 20 ? "am" : ""}`}>{halted ? "HALTED" : lag === null ? "–" : `${int(lag)} blk`}</div>
          <div className="sub">{cursor ? `cursor #${int(cursor.block)} · ${since(cursor.updatedAt, now)} ago` : "no deployment indexed"}</div>
        </div>
        <div className="kpi">
          <div className="label">Outbox backlog</div>
          <div className={`val ${count(o, "review") > 0 ? "am" : ""}`}>{int(backlog)}</div>
          <div className="sub">{backlog > 0 ? `oldest ${age(oldestOpen)}` : "nothing waiting"}</div>
        </div>
        <div className="kpi">
          <div className="label">Awaiting approval</div>
          <div className={`val ${o.signer.pendingApprovals > 0 ? "am" : ""}`}>{int(o.signer.pendingApprovals)}</div>
          <div className="sub">signer maker-checker</div>
        </div>
        <div className="kpi">
          <div className="label">Payout gate</div>
          <div className={`val ${gate?.allowed ? "up" : "dn"}`}>{gate?.allowed ? "Open" : gate?.frozen ? "Frozen" : "Closed"}</div>
          <div className="sub">{run ? `run #${String(run.id)} ${run.status} · ${since(run.finishedAt ?? run.startedAt, now)} ago` : "no run yet"}</div>
        </div>
        <div className="kpi">
          <div className="label">Public anchor</div>
          <div className={`val ${anchor?.status === "confirmed" ? "up" : anchor?.status === "failed" ? "dn" : anchor ? "am" : ""}`}>
            {anchor ? anchor.status : "None"}
          </div>
          <div className="sub">{anchor ? `#${int(anchor.besuBlock)} · ${since(anchor.createdAt, now)} ago` : "not anchored yet"}</div>
        </div>
      </section>

      <div className="g2">
        <section className="card" aria-labelledby="ob">
          <h2 id="ob">
            Outbox pipeline <span className="sp" />
            <span className="chip ok">exactly-once (O-1..O-7)</span>
          </h2>
          <div className="lane">
            {LANES.map((s) => (
              <div key={s}>
                <b className={s === "confirmed" ? "up" : s === "failed" ? "dn" : s === "review" ? "am" : ""}>{int(count(o, s))}</b>
                <small>{s}</small>
              </div>
            ))}
          </div>
          <div className="tbl-wrap" style={{ marginBlockStart: 10 }}>
            <table className="t">
              <caption>Latest commands (no payloads shown)</caption>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Command</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="n">
                    Tries
                  </th>
                  <th scope="col" className="n">
                    Age
                  </th>
                </tr>
              </thead>
              <tbody>
                {o.outboxRecent.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="empty">
                      No commands in this database yet.
                    </td>
                  </tr>
                ) : (
                  o.outboxRecent.map((c) => (
                    <tr key={c.id}>
                      <td className="mono">{c.id}</td>
                      <td>
                        <span className="mono">{c.kind}</span>
                        {c.txHash ? <div className="hash">tx {short(c.txHash)}</div> : null}
                        {c.lastError ? <div className="small am">{c.lastError}</div> : null}
                      </td>
                      <td>{statusChip(c.status)}</td>
                      <td className="n">
                        {c.attempts}/{c.maxAttempts}
                      </td>
                      <td className="n">{age(c.ageSeconds)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <div className="stack">
          <section className="card" aria-labelledby="vals">
            <h2 id="vals">
              Validators <span className="sp" />
              <span className="mono di small">
                chain {chain.chainId ?? "–"} · peers {chain.peers ?? "–"}
              </span>
            </h2>
            {chain.validators.length === 0 ? (
              <p className="empty">{chain.ok ? "No validator list from the node." : `Besu RPC unreachable: ${chain.error ?? ""}`}</p>
            ) : (
              <div className="val4">
                {chain.validators.map((v) => {
                  const fresh = v.lastProposed !== null && recentHeads - v.lastProposed < 24;
                  return (
                    <div key={v.address} className={fresh ? "" : "stale"}>
                      <b className={fresh ? "up" : "am"}>
                        {fresh ? "●" : "○"} {short(v.address, 4)}
                      </b>
                      <small>{v.lastProposed === null ? "no block in last 12" : `proposed #${int(v.lastProposed)}`}</small>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="card" aria-labelledby="rec">
            <h2 id="rec">Reconciliation and payout gate</h2>
            <ul className="checks">
              <li>
                <i className={gate?.allowed ? "" : "no"} aria-hidden="true">
                  {gate?.allowed ? "✓" : "✕"}
                </i>
                <span>
                  {gate?.allowed ? "Payouts allowed" : "Payouts denied"}: <span className="mu">{gate?.reason ?? "no gate"}</span>
                </span>
              </li>
              <li>
                <i className={run?.status === "passed" ? "" : run ? "no" : "wait"} aria-hidden="true">
                  {run?.status === "passed" ? "✓" : run ? "!" : "…"}
                </i>
                <span>
                  {run
                    ? `Last run #${String(run.id)}: ${run.status}, ${int(run.blocking)} blocking / ${int(run.warnings)} warnings, pinned to block #${int(run.pinnedBlock)}`
                    : "No reconciliation run in this database"}
                </span>
              </li>
              {o.recon.lastFindings.slice(0, 4).map((f) => (
                <li key={`${f.check}-${f.severity}`}>
                  <i className={f.severity === "blocking" ? "no" : "wait"} aria-hidden="true">
                    {f.severity === "blocking" ? "✕" : "!"}
                  </i>
                  <span>
                    <span className="mono">{f.check}</span> <span className="mu">× {int(f.count)}</span>
                  </span>
                </li>
              ))}
              <li>
                <i className={o.recon.openUnfreezeRequests > 0 ? "wait" : ""} aria-hidden="true">
                  {o.recon.openUnfreezeRequests > 0 ? "…" : "✓"}
                </i>
                <span>{int(o.recon.openUnfreezeRequests)} open unfreeze requests (two operators)</span>
              </li>
            </ul>
          </section>
        </div>
      </div>

      <div className="g3">
        <section className="card" aria-labelledby="idx">
          <h2 id="idx">Indexer and anchoring</h2>
          <dl className="kv">
            {o.indexer.length === 0 ? (
              <>
                <dt>Deployments</dt>
                <dd>none indexed</dd>
              </>
            ) : (
              o.indexer.map((d) => (
                <Fragment key={d.deployment}>
                  <dt className="mono" title={d.deployment}>
                    {short(d.deployment, 4)}
                  </dt>
                  <dd className={d.haltedAt ? "dn" : ""}>
                    {d.haltedAt ? `halted: ${d.haltReason ?? ""}` : `#${int(d.block)} · ${int(d.events)} events`}
                  </dd>
                </Fragment>
              ))
            )}
            <dt>Anchors confirmed</dt>
            <dd>{int(o.anchor.confirmed)}</dd>
            <dt>Anchors open / failed 24 h</dt>
            <dd className={o.anchor.failed24h > 0 ? "dn" : ""}>
              {int(o.anchor.open)} / {int(o.anchor.failed24h)}
            </dd>
            <dt>Ledger journals</dt>
            <dd>
              {int(o.ledger.journals)} <span className="di small">last {pkt(o.ledger.lastAt)}</span>
            </dd>
          </dl>
        </section>
        <section className="card" aria-labelledby="kyc">
          <h2 id="kyc">KYC queue</h2>
          <dl className="kv">
            <dt>Subjects</dt>
            <dd>{int(o.kyc.subjects)}</dd>
            {Object.entries(o.kyc.byStatus).map(([k, n]) => (
              <Fragment key={k}>
                <dt>{k}</dt>
                <dd className={k === "review" ? "am" : k === "rejected" || k === "revoked" ? "dn" : ""}>
                  {int(n)}
                </dd>
              </Fragment>
            ))}
            <dt>Sanctions reviews open (two officers)</dt>
            <dd className={o.kyc.openClearances > 0 ? "am" : ""}>{int(o.kyc.openClearances)}</dd>
          </dl>
        </section>
        <section className="card" aria-labelledby="bank">
          <h2 id="bank">Bank queue</h2>
          <dl className="kv">
            {["created", "approved", "submitted", "rejected"].map((s) => (
              [s, new Map(Object.entries(o.bank.batches)).get(s) ?? 0] as const
            )).map(([s, n]) => (
              <Fragment key={s}>
                <dt>Payout batches {s}</dt>
                <dd className={s === "created" && n > 0 ? "am" : ""}>
                  {int(n)}
                </dd>
              </Fragment>
            ))}
            <dt>Credits in suspense</dt>
            <dd className={o.bank.suspense > 0 ? "am" : ""}>{int(o.bank.suspense)}</dd>
            <dt>Payout accounts in 72 h cooling-off</dt>
            <dd>{int(o.bank.coolingOff)}</dd>
          </dl>
        </section>
      </div>
      <p className="small di">
        Read at {pkt(o.at)} in {readMs} ms (database {o.indexer.length > 0 ? "read model" : "empty read model"}, Besu RPC {chain.readMs} ms).
        Counts and health only: no payloads, no personal data. Reload to refresh.
      </p>
    </Shell>
  );
}
