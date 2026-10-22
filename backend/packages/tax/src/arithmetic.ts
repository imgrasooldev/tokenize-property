/**
 * Distribution and withholding arithmetic (spec S-03 OP-35, OP-36; migration 0021 OT-4), in
 * integer paisa with bigint only: no floating point anywhere. The database computes the same
 * numbers (ops.calculate_distribution, tax.withholding); the tests prove both agree.
 *
 * Rounding rule: WHT = floor((gross x ratePpm + 500,000) / 1,000,000), i.e. the exact amount
 * rounded half up to the paisa (gross and rate are never negative). Net = gross - WHT.
 */

/** Rates are parts per million of the gross: 150,000 = 15 %. */
export const RATE_SCALE = 1_000_000n;
const HALF = RATE_SCALE / 2n;

export function withholding(gross: bigint, ratePpm: bigint | number): bigint {
  const rate = BigInt(ratePpm);
  if (gross < 0n) throw new Error("gross must not be negative");
  if (rate < 0n || rate >= RATE_SCALE) throw new Error("rate must be 0 to 999,999 parts per million");
  return (gross * rate + HALF) / RATE_SCALE;
}

/**
 * Splits `total` paisa pro rata to units by the largest remainder: everyone gets the floor of the
 * exact share, then the paisa left over go one each to the largest remainders, ties by wallet
 * ascending (as chain/rent.py and the database). The parts always sum to `total`.
 */
export function largestRemainder(total: bigint, units: ReadonlyMap<string, bigint>): Map<string, bigint> {
  if (total < 0n) throw new Error("total must not be negative");
  let supply = 0n;
  for (const u of units.values()) {
    if (u <= 0n) throw new Error("units must be positive");
    supply += u;
  }
  if (supply === 0n) throw new Error("no units");
  const rows = [...units].map(([wallet, u]) => ({ wallet, base: (total * u) / supply, rem: (total * u) % supply }));
  let left = total - rows.reduce((s, r) => s + r.base, 0n);
  rows.sort((a, b) => (a.rem !== b.rem ? (a.rem > b.rem ? -1 : 1) : a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));
  const out = new Map<string, bigint>();
  for (const r of rows) {
    out.set(r.wallet, r.base + (left > 0n ? 1n : 0n));
    if (left > 0n) left--;
  }
  return out;
}

export interface Holder {
  wallet: string;
  units: bigint;
  /** Rate of the holder's filer status at the record date. */
  ratePpm: bigint | number;
}

export interface Line {
  wallet: string;
  units: bigint;
  gross: bigint;
  wht: bigint;
  net: bigint;
}

/** Gross by largest remainder, then WHT and net per line; lines with a zero gross are dropped (as in the database). */
export function splitDistribution(distributable: bigint, holders: readonly Holder[]): Line[] {
  const rate = new Map(holders.map((h) => [h.wallet, h.ratePpm]));
  const gross = largestRemainder(distributable, new Map(holders.map((h) => [h.wallet, h.units])));
  const lines: Line[] = [];
  for (const h of [...holders].sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0))) {
    const g = gross.get(h.wallet) ?? 0n;
    if (g === 0n) continue;
    const w = withholding(g, rate.get(h.wallet) ?? 0);
    lines.push({ wallet: h.wallet, units: h.units, gross: g, wht: w, net: g - w });
  }
  return lines;
}

/** Paisa as rupees with two decimals, from bigint (no floating point): 123456n -> "1234.56". */
export function rupees(paisa: bigint): string {
  const neg = paisa < 0n;
  const a = neg ? -paisa : paisa;
  return `${neg ? "-" : ""}${(a / 100n).toString()}.${(a % 100n).toString().padStart(2, "0")}`;
}

/** A rate in parts per million as a percentage with four decimals: 150000 -> "15.0000". */
export function percent(ratePpm: bigint | number): string {
  const r = BigInt(ratePpm);
  return `${(r / 10_000n).toString()}.${(r % 10_000n).toString().padStart(4, "0")}`;
}
