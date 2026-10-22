/**
 * Succession allocation (spec S-06 RC-13, RF-14), the TypeScript twin of recovery.allocation() in
 * migration 0020. Each heir gets floor(balance x share); the units left over go one each to the
 * largest fractional remainders (ties: the heir added first) only when all adult heirs signed a
 * family settlement; otherwise they stay with the deceased's wallet for a cash-out (RC-14).
 * Exact integer arithmetic only (bigint): no rounding anywhere.
 */
export interface HeirShare {
  /** Order of addition (the tie-break). */
  id: bigint;
  num: bigint;
  den: bigint;
}

export interface Allocation {
  units: Map<bigint, bigint>;
  /** Units not allocated (stay frozen in the deceased's wallet). */
  residual: bigint;
}

export class AllocationError extends Error {
  override name = "AllocationError";
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** Whether the shares sum to exactly 1. */
export function sharesComplete(heirs: readonly HeirShare[]): boolean {
  if (heirs.length === 0) return false;
  let num = 0n;
  let den = 1n;
  for (const h of heirs) {
    num = num * h.den + h.num * den;
    den *= h.den;
    const g = gcd(num, den);
    num /= g;
    den /= g;
  }
  return num === den;
}

export function allocate(balance: bigint, heirs: readonly HeirShare[], settlement: boolean): Allocation {
  if (balance < 0n) throw new AllocationError("negative balance");
  for (const h of heirs) {
    if (h.num <= 0n || h.den <= 0n || h.num > h.den) throw new AllocationError(`heir ${h.id.toString()}: a share is 0 < numerator <= denominator`);
  }
  const base = heirs.map((h) => ({ h, units: (balance * h.num) / h.den, rem: (balance * h.num) % h.den }));
  let leftover = balance - base.reduce((s, b) => s + b.units, 0n);
  const units = new Map(base.map((b) => [b.h.id, b.units]));
  if (settlement && leftover > 0n) {
    // Largest remainder first: compare r1/d1 with r2/d2 exactly by cross-multiplication.
    const order = [...base].sort((a, b) => {
      const l = a.rem * b.h.den;
      const r = b.rem * a.h.den;
      if (l !== r) return l > r ? -1 : 1;
      return a.h.id < b.h.id ? -1 : a.h.id > b.h.id ? 1 : 0;
    });
    for (const b of order) {
      if (leftover === 0n) break;
      units.set(b.h.id, (units.get(b.h.id) ?? 0n) + 1n);
      leftover -= 1n;
    }
  }
  return { units, residual: leftover };
}
