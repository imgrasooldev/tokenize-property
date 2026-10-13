import { NextResponse, type NextRequest } from "next/server";
import { sha256Hex, sha256sums, zipStore } from "@/lib/export";
import { decision } from "@/lib/server/approvals";
import { strExportData } from "@/lib/server/compliance";
import { ID } from "@/lib/server/compliance-route";
import { officerMessage, pgCode } from "@/lib/server/db";
import { seeOther } from "@/lib/server/http";
import { requireApi } from "@/lib/server/session";

/**
 * FMU export of one STR case (ZIP: case JSON, manifest.json, SHA256SUMS). Nothing is sent anywhere:
 * the MLRO files it with the FMU by hand (goAML) and records the FMU reference afterwards. The
 * export is recorded (compliance and admin audit, with the file's SHA-256, step-up checked by the
 * database) BEFORE the file is handed out; the manifest names that audit entry.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const form = await request.formData().catch(() => undefined);
  const officer = await requireApi(request, "compliance.export", form);
  if (!("sessionHash" in officer)) return officer;
  const back = (msg: string) => seeOther(`${ID.test(id) ? `/compliance/str/${id}` : "/compliance/str"}?error=${encodeURIComponent(msg.slice(0, 300))}`);
  if (!ID.test(id)) return back("Unknown case.");
  // Only the page's own button (after the step-up) asks for a file.
  if (form?.get("decision") !== "export") return back("Use the export button on the case page.");
  try {
    const data = await strExportData(officer.sessionHash, id);
    if (!data) return back("Unknown case.");
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
    const dataName = `str-case-${id}-${stamp}Z.json`;
    const bytes = new TextEncoder().encode(`${JSON.stringify(data, null, 2)}\n`);
    const sha = sha256Hex(bytes);
    const r = await decision("SELECT admin.record_str_export($1, $2, $3) AS r", [officer.sessionHash, id, sha]);
    if (!r.ok) return back(r.error ?? "refused");
    const rec = r as typeof r & { auditId?: string; auditHash?: string; at?: string };
    const manifest = {
      kind: "pt-str-export-v1",
      case: Number(id),
      generatedAtUtc: rec.at ?? null,
      generatedBy: { officer: officer.id, handle: officer.handle },
      files: [{ name: dataName, bytes: bytes.length, sha256: sha }],
      exportRecord: { compliance: r.id ?? null, adminAuditEntry: rec.auditId ?? null, adminAuditHash: rec.auditHash ?? null },
      note: "For a manual filing with the Financial Monitoring Unit. Confidential: never disclose to the investor (tipping-off).",
    };
    const files = [
      { name: dataName, data: bytes },
      { name: "manifest.json", data: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`) },
    ];
    const zip = zipStore([...files, { name: "SHA256SUMS", data: new TextEncoder().encode(sha256sums(files)) }], new Date(rec.at ?? Date.now()));
    return new NextResponse(Buffer.from(zip), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="str-case-${id}-${stamp}Z.zip"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    if (pgCode(e) === "PTS01") return back("Confirm with your security key first (step-up).");
    const msg = officerMessage(e);
    if (msg) return back(msg);
    throw e;
  }
}
