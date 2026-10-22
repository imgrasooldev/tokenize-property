import { createHash } from "node:crypto";
import type { Form } from "./compliance-route";

/**
 * Input parsing shared by the S-03 routes (migration 0021). No floating point: rupee amounts and
 * percentages are parsed as decimal strings into integer paisa and parts per million.
 */
export const TOKEN = /^0x[0-9a-f]{40}$/;
export const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** "175000", "175,000.5", "175000.50" -> paisa as a decimal string; null if not a positive amount. */
export function paisaOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const [whole, frac, extra] = v.trim().replaceAll(",", "").split(".");
  if (extra !== undefined || !whole || !/^\d{1,13}$/.test(whole) || (frac !== undefined && !/^\d{1,2}$/.test(frac))) return null;
  const p = BigInt(whole) * 100n + BigInt((frac ?? "").padEnd(2, "0"));
  return p > 0n ? p.toString() : null;
}

/** "15", "12.5", "0.0001" (percent) -> parts per million (integer below 1,000,000); null otherwise. */
export function ppmOf(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const [whole, frac, extra] = v.trim().split(".");
  if (extra !== undefined || !whole || !/^\d{1,2}$/.test(whole) || (frac !== undefined && !/^\d{1,4}$/.test(frac))) return null;
  return Number(whole) * 10_000 + Number((frac ?? "").padEnd(4, "0"));
}

/** SHA-256 of an uploaded evidence file (the file itself is not kept), or of a pasted hex digest. */
export async function evidenceOf(form: Form): Promise<string | null> {
  const file = form?.get("evidenceFile");
  if (file && typeof file === "object" && "arrayBuffer" in file && file.size > 0) {
    if (file.size > 20 * 1024 * 1024) return null;
    return createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex");
  }
  const hex = form?.get("evidence");
  return typeof hex === "string" && /^[0-9a-f]{64}$/.test(hex.trim().toLowerCase()) ? hex.trim().toLowerCase() : null;
}
