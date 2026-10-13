/** Display helpers. Server-rendered only, so no clock or locale differences between server and browser. */
const INT = new Intl.NumberFormat("en-PK");
const PKT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Karachi",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function int(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? "–" : INT.format(n);
}

/** "12 s", "4 min", "3 h", "2 d". */
export function age(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "–";
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s} s`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

export function since(iso: string | Date | null | undefined, now: number): string {
  if (!iso) return "–";
  const t = typeof iso === "string" ? Date.parse(iso) : iso.getTime();
  return Number.isFinite(t) ? age((now - t) / 1000) : "–";
}

/** Pakistan time for officers (PKT, UTC+5). */
export function pkt(d: string | Date | null | undefined): string {
  if (!d) return "–";
  const t = typeof d === "string" ? new Date(d) : d;
  return Number.isFinite(t.getTime()) ? `${PKT.format(t)} PKT` : "–";
}

/** UTC as stored in the audit digests: 2026-10-13 07:41:02Z. */
export function utc(d: string | Date | null | undefined): string {
  if (!d) return "–";
  const t = typeof d === "string" ? new Date(d) : d;
  return Number.isFinite(t.getTime()) ? `${t.toISOString().slice(0, 19).replace("T", " ")}Z` : "–";
}

export function short(hex: string | null | undefined, n = 6): string {
  if (!hex) return "–";
  return hex.length > 2 * n + 1 ? `${hex.slice(0, n + (hex.startsWith("0x") ? 2 : 0))}…${hex.slice(-n)}` : hex;
}
