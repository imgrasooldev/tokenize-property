import type { Lang } from "@/lib/i18n";
import { formatNumber } from "@/lib/i18n";
import { fill } from "@/lib/i18n-verify";
import { label, type OfferingDict } from "@/lib/i18n-offering";
import { bpText, formatPaisa, progressBp } from "@/lib/offering-rules";
import type { PublicOffering } from "@/lib/server/offerings";

/** Shared pieces of the offering list and detail pages (server components). */

export function placeOf(o: Pick<PublicOffering, "district" | "province">, l: OfferingDict): string {
  const parts = [o.district, o.province ? label(l, "province_", o.province, o.province) : null].filter((x): x is string => Boolean(x));
  return parts.length > 0 ? parts.join(", ") : l.unknownPlace;
}

export function offeringTitle(o: PublicOffering, l: OfferingDict): string {
  return fill(l.offeringIn, { d: placeOf(o, l) });
}

const STATE_TONE: Record<string, string> = { live: "ok", ready: "cy", closing: "warn", suspended: "warn", funded: "ok", completing: "cy", completed: "ok", failed: "bad", refunding: "warn", cancelled: "gray" };

export function OfferingState({ state, l }: { state: string; l: OfferingDict }) {
  const tone = new Map(Object.entries(STATE_TONE)).get(state) ?? "gray";
  return (
    <span className={`chip ${tone}`} data-testid="offering-state">
      {state === "live" && <span className="dot" aria-hidden="true" />}
      {label(l, "st_", state)}
    </span>
  );
}

/** Raised so far (paid units x price) against the raise target, as a bar with the figures. */
export function RaiseProgress({ o, l, lang }: { o: PublicOffering; l: OfferingDict; lang: Lang }) {
  const bp = progressBp(o.paidUnits, o.targetUnits);
  return (
    <div className="raise">
      <div className="row-between small">
        <span className="mu">{l.raisedSoFar}</span>
        <b data-testid="raised">{formatPaisa(o.paidUnits * o.pricePaisa, lang)}</b>
      </div>
      <div
        className="bar"
        role="progressbar"
        aria-label={l.raisedSoFar}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.floor(bp / 100)}
        aria-valuetext={fill(l.ofTarget, { p: bpText(bp) })}
      >
        <i style={{ inlineSize: `${bpText(bp)}%` }} />
      </div>
      <div className="row-between small mu">
        <span>{fill(l.ofTarget, { p: bpText(bp) })}</span>
        <span>
          {l.raiseTarget}: {formatPaisa(o.targetUnits * o.pricePaisa, lang)}
        </span>
      </div>
      <div className="small mu">
        {fill(l.unitsN, { n: formatNumber(o.paidUnits, lang) })} / {fill(l.unitsN, { n: formatNumber(o.targetUnits, lang) })}
      </div>
    </div>
  );
}
