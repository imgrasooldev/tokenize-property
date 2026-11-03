import type { Metadata } from "next";
import { ComplianceTabs } from "@/components/ComplianceTabs";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { StepUpForm } from "@/components/StepUp";
import { short } from "@/lib/format";
import { offboardingList, stateChip } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Offboarding" };

/**
 * Offboarding (migration 0055; contract-spec offboarding order): every investor who is not verified
 * and has a bound wallet. Step 1 is the freeze (automatic or on /compliance/freezes); step 2, moving
 * or redeeming the units, happens only through an S-06 case or an S-04 transfer; step 3, deleting the
 * identity, is requested here once the wallet holds no units and decided by a second officer.
 */
export default async function OffboardingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("compliance.read", "/compliance/offboarding");
  const q = await searchParams;
  const o = await offboardingList(officer.sessionHash);
  const canDecide = officer.permissions.has("compliance.decide");
  const units = (n: string) => Number(n).toLocaleString("en-PK");

  return (
    <Shell officer={officer} current="/compliance/freezes" title="Offboarding">
      <ComplianceTabs current="/compliance/offboarding" />
      <Flash q={q} />
      <section className="card" aria-labelledby="off">
        <h2 id="off">Investors who are not verified ({o.investors.length})</h2>
        <p className="di small">
          Order (findings F-01/F-02): 1 freeze the wallet · 2 move the units (S-06 forced transfer or burn under an order, or an S-04 transfer) · 3 only at zero units, delete the
          identity through the timelock. Nothing on this page moves a unit.
        </p>
        {o.investors.length === 0 ? (
          <p className="empty">Nobody to offboard.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="t" data-testid="offboarding">
              <thead>
                <tr>
                  <th scope="col">Investor</th>
                  <th scope="col">Status</th>
                  <th scope="col">Wallet</th>
                  <th scope="col">1 Frozen</th>
                  <th scope="col">2 Units held</th>
                  <th scope="col">Open cases</th>
                  <th scope="col">3 Identity</th>
                  {canDecide ? <th scope="col">Delete identity</th> : null}
                </tr>
              </thead>
              <tbody>
                {o.investors.map((x) => (
                  <tr key={x.wallet}>
                    <td className="mono">{x.ref}</td>
                    <td>
                      <span className={stateChip(x.status)}>{x.status}</span>
                    </td>
                    <td className="mono small">{short(x.wallet, 6)}</td>
                    <td>{x.frozen ? "yes" : <span className="dn">no</span>}</td>
                    <td>{units(x.units)}</td>
                    <td className="small">
                      {x.recoveryCases > 0 ? <a href="/recovery">{x.recoveryCases} recovery</a> : null} {x.transferCases > 0 ? <a href="/transfers">{x.transferCases} transfer</a> : null}
                      {x.recoveryCases === 0 && x.transferCases === 0 ? "–" : null}
                    </td>
                    <td>
                      {x.deletion ? (
                        <a href={`/compliance/offboarding/${String(x.deletion.id)}`}>
                          <span className={stateChip(x.deletion.status)}>{x.deletion.status}</span>
                        </a>
                      ) : x.registered ? (
                        "registered"
                      ) : (
                        "none"
                      )}
                    </td>
                    {canDecide ? (
                      <td>
                        {x.registered && x.units === "0" && (!x.deletion || ["rejected", "expired"].includes(x.deletion.status)) ? (
                          <StepUpForm csrf={officer.csrf} action="/api/compliance/offboarding">
                            <input type="hidden" name="wallet" value={x.wallet} />
                            <textarea name="reason" required minLength={10} maxLength={500} placeholder="Reason (no CNIC, IBAN or phone number)" aria-label={`Reason for ${x.ref}`} />
                            <button className="btn" type="submit" name="decision" value="request">
                              Request deletion with security key
                            </button>
                          </StepUpForm>
                        ) : (
                          <span className="mu small">{x.units !== "0" ? "units first" : "–"}</span>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Shell>
  );
}
