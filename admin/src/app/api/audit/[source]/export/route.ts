import { NextResponse, type NextRequest } from "next/server";
import { sha256Hex, sha256sums, toCsv, toJson, zipStore, type Manifest } from "@/lib/export";
import { isAuditSource, sourcePermission } from "@/lib/routes";
import { auditRows, parseFilters, recordExport, verifyChains } from "@/lib/server/audit";
import { deny, requireApi } from "@/lib/server/session";

const MAX_ROWS = 50_000;

/**
 * Evidence export (ZIP: data file, manifest.json, SHA256SUMS). The export is recorded in the
 * hash-chained admin audit log, with the data file's SHA-256, BEFORE the file is handed out; the
 * manifest names that audit entry, so a regulator can check the file against the log.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ source: string }> }) {
  const { source } = await ctx.params;
  const form = await request.formData().catch(() => undefined);
  if (!isAuditSource(source)) return deny(400, "unknown audit source");
  const officer = await requireApi(request, "audit.export", form);
  if (!("sessionHash" in officer)) return officer;
  if (!officer.permissions.has(sourcePermission(source))) return deny(403, "not permitted for your role");
  const format = form?.get("format") === "json" ? "json" : "csv";
  const filters = parseFilters((k) => form?.get(k));
  const exportFilters = { ...filters, before: null };

  const [rows, checks] = await Promise.all([
    auditRows(officer.sessionHash, source, exportFilters, MAX_ROWS),
    verifyChains(officer.sessionHash, source),
  ]);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const dataName = `${source}-audit-${stamp}Z.${format}`;
  const data = new TextEncoder().encode(format === "json" ? toJson(rows) : toCsv(rows));
  const dataSha = sha256Hex(data);
  const entry = await recordExport(officer.sessionHash, source, exportFilters, rows.length, format, dataSha);
  const check = checks[0];
  const manifest: Manifest = {
    kind: "pt-admin-audit-export-v1",
    source,
    format,
    filters: exportFilters,
    rows: rows.length,
    generatedAtUtc: entry.at.toISOString(),
    generatedBy: { officer: officer.id, handle: officer.handle },
    chainVerification: check
      ? { entries: check.entries, problems: check.problems, firstProblem: check.firstProblem, verifiedAtUtc: check.verifiedAt.toISOString() }
      : null,
    files: [{ name: dataName, bytes: data.length, sha256: dataSha }],
    exportAuditEntry: { source: "admin", id: entry.id, hash: entry.hash },
    note:
      rows.length === MAX_ROWS
        ? `Truncated at ${String(MAX_ROWS)} rows (newest first): narrow the date range.`
        : "Complete for the filters above. Rows are newest first; each row's hash covers the previous one.",
  };
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const files = [
    { name: dataName, data },
    { name: "manifest.json", data: manifestBytes },
  ];
  const sums = new TextEncoder().encode(sha256sums(files));
  const zip = zipStore([...files, { name: "SHA256SUMS", data: sums }], entry.at);
  return new NextResponse(Buffer.from(zip), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${source}-audit-${stamp}Z.zip"`,
      "Cache-Control": "no-store",
      "X-Export-Audit-Id": entry.id,
    },
  });
}
