import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DecisionPanel, Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { TrusteeTabs } from "@/components/TrusteeTabs";
import { pkt } from "@/lib/format";
import { stateChip } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";
import { adjustment, units } from "@/lib/server/trustee";

export const metadata: Metadata = { title: "Register adjustment" };

/**
 * One proposed adjustment of the trustee's register: the wallet, the units, the evidence hash and
 * the balances now (register and chain read model at the pinned block). A different trustee officer
 * decides with a step-up; the decision is bound to the adjustment's digest.
 */
export default async function AdjustmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const valid = /^[1-9]\d{0,17}$/.test(id);
  const officer = await requirePage("trustee.read", `/trustee/register/adjustments/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const a = await adjustment(officer.sessionHash, id);
  if (!a) notFound();
  const after = (BigInt(a.registerBalance) + (a.status === "open" ? BigInt(a.units) : 0n)).toString();

  return (
    <Shell officer={officer} current="/trustee/register" title={`Register adjustment #${String(a.id)}`}>
      <TrusteeTabs current="/trustee/register" />
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="what">
          <h2 id="what">
            {BigInt(a.units) > 0n ? "Add units to the register" : "Remove units from the register"} <span className="sp" />
            <span className={stateChip(a.status)} data-testid="adjustment-status">
              {a.status}
            </span>
          </h2>
          <dl className="kv">
            <dt>Token</dt>
            <dd className="mono small">
              <a href={`/trustee/register?token=${a.token}`}>{a.token}</a>
            </dd>
            <dt>Wallet</dt>
            <dd className="mono small">{a.wallet}</dd>
            <dt>Units</dt>
            <dd className="mono">{units(a.units)}</dd>
            <dt>Evidence SHA-256</dt>
            <dd className="mono small">{a.evidenceSha256}</dd>
            <dt>Reason</dt>
            <dd>{a.reason}</dd>
            <dt>Proposed by</dt>
            <dd className="mono">
              {a.proposedBy} · {pkt(a.proposedAt)}
            </dd>
            <dt>Expires</dt>
            <dd>{pkt(a.expiresAt)}</dd>
            <dt>Decided</dt>
            <dd>{a.decidedBy ? `${a.decidedBy} · ${pkt(a.decidedAt)} · ${a.decisionReason ?? ""}` : "–"}</dd>
            {a.entryId ? (
              <>
                <dt>Register entry</dt>
                <dd className="mono">#{a.entryId}</dd>
              </>
            ) : null}
            <dt>Digest</dt>
            <dd className="mono small">{a.digest}</dd>
          </dl>
        </section>
        <section className="card" aria-labelledby="bal">
          <h2 id="bal">Balances now</h2>
          <dl className="kv">
            <dt>Register</dt>
            <dd className="mono" data-testid="register-balance">
              {units(a.registerBalance)}
            </dd>
            <dt>Register after approval</dt>
            <dd className="mono">{units(after)}</dd>
            <dt>Chain (read model)</dt>
            <dd className="mono">
              {units(a.chainBalance)} at block #{a.pinned?.block ?? "–"}
            </dd>
          </dl>
          <h2 style={{ marginBlockStart: 12 }}>Your decision</h2>
          <DecisionPanel
            csrf={officer.csrf}
            action={`/api/trustee/register/adjustments/${String(a.id)}/decide`}
            hidden={{ digest: a.digest }}
            blockers={a.blockers}
            approveBlockers={a.approveBlockers}
            note="Recorded in the trustee and admin audit chains."
          />
        </section>
      </div>
    </Shell>
  );
}
