import { createHash } from "node:crypto";

/**
 * Evidence exports for regulators and auditors: the rows as CSV or JSON, a manifest, and a
 * SHA256SUMS file (checkable with `sha256sum -c SHA256SUMS`), packed in an uncompressed ZIP.
 * Pure functions, no dependencies, deterministic for the same input.
 */
export interface AuditRow {
  id: string;
  at: string;
  actor: string;
  action: string;
  ref: string | null;
  detail: unknown;
  prevHash: string;
  hash: string;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** RFC 4180 CSV. Cells that a spreadsheet would run as a formula are prefixed with ' (OWASP CSV injection). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(rows: readonly AuditRow[]): string {
  const head = ["id", "at_utc", "actor", "action", "ref", "detail", "prev_hash", "hash"];
  const lines = rows.map((r) => [r.id, r.at, r.actor, r.action, r.ref, r.detail, r.prevHash, r.hash].map(csvCell).join(","));
  return `${[head.join(","), ...lines].join("\r\n")}\r\n`;
}

export function toJson(rows: readonly AuditRow[]): string {
  return `${JSON.stringify(rows, null, 2)}\n`;
}

// ------------------------------------------------------------------ ZIP (stored, no compression)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t.set([c >>> 0], n);
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = (CRC_TABLE.at((c ^ b) & 0xff) ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS date/time of a fixed instant, so the same export is byte-identical. */
function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

export function zipStore(files: readonly { name: string; data: Uint8Array }[], when: Date): Uint8Array {
  const { time, date } = dosTime(when);
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(f.name)) throw new Error("bad file name in export");
    const name = Buffer.from(f.name, "ascii");
    const crc = crc32(f.data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0, 6);
    h.writeUInt16LE(0, 8);
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(f.data.length, 18);
    h.writeUInt32LE(f.data.length, 22);
    h.writeUInt16LE(name.length, 26);
    h.writeUInt16LE(0, 28);
    local.push(h, name, Buffer.from(f.data));
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(f.data.length, 20);
    c.writeUInt32LE(f.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, cd, end]));
}

/** Reads back a stored ZIP (tests and auditors' tooling): name -> bytes, checking every CRC. */
export function unzipStore(zip: Uint8Array): Map<string, Uint8Array> {
  const b = Buffer.from(zip);
  const out = new Map<string, Uint8Array>();
  let p = 0;
  while (b.readUInt32LE(p) === 0x04034b50) {
    const crc = b.readUInt32LE(p + 14);
    const size = b.readUInt32LE(p + 18);
    const nameLen = b.readUInt16LE(p + 26);
    const name = b.subarray(p + 30, p + 30 + nameLen).toString("ascii");
    const data = new Uint8Array(b.subarray(p + 30 + nameLen, p + 30 + nameLen + size));
    if (crc32(data) !== crc) throw new Error(`CRC mismatch in ${name}`);
    out.set(name, data);
    p += 30 + nameLen + size;
  }
  return out;
}

export interface Manifest {
  kind: "pt-admin-audit-export-v1";
  source: string;
  format: "csv" | "json";
  filters: Record<string, string | null>;
  rows: number;
  generatedAtUtc: string;
  generatedBy: { officer: string; handle: string };
  chainVerification: { entries: number; problems: number; firstProblem: string | null; verifiedAtUtc: string } | null;
  files: { name: string; bytes: number; sha256: string }[];
  exportAuditEntry: { source: "admin"; id: string; hash: string };
  note: string;
}

export function sha256sums(files: readonly { name: string; data: Uint8Array }[]): string {
  return files.map((f) => `${sha256Hex(f.data)}  ${f.name}\n`).join("");
}
