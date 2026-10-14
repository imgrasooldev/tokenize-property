import { createHash, randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { sha256sums, zipStore } from "@/lib/export";
import { decision } from "@/lib/server/approvals";
import { ID } from "@/lib/server/compliance-route";
import { officerMessage, pgCode } from "@/lib/server/db";
import { seeOther } from "@/lib/server/http";
import { requireApi } from "@/lib/server/session";
import { generateExport } from "@/lib/server/tax-service";

/**
 * Generates an approved FBR filing export (ADR 0014). The admin database issues a one-time ticket
 * (2 minutes) to one of the export's two officers after a fresh step-up; the tax service, the only
 * holder of the CNIC key, redeems it, builds the file and records its SHA-256 BEFORE releasing it.
 * The portal checks the digest, packs the file with a manifest, and streams it once (no-store).
 * The file holds full CNICs: it is never logged, cached or kept here.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const form = await request.formData().catch(() => undefined);
  const officer = await requireApi(request, "tax.export", form);
  if (!("sessionHash" in officer)) return officer;
  const back = (msg: string) => seeOther(`${ID.test(id) ? `/tax/exports/${id}` : "/tax/exports"}?error=${encodeURIComponent(msg.slice(0, 300))}`);
  if (!ID.test(id)) return back("Unknown export.");
  // Only the page's own button (after the step-up) asks for a file.
  if (form?.get("decision") !== "generate") return back("Use the generate button on the export page.");
  try {
    const ticket = randomBytes(32);
    const issued = await decision("SELECT admin.issue_tax_export_ticket($1, $2, $3) AS r", [officer.sessionHash, id, createHash("sha256").update(ticket).digest()]);
    if (!issued.ok) return back(issued.error ?? "refused");
    const r = await generateExport(id, ticket);
    if (!r.ok) return back(r.error);
    const f = r.file;
    const manifest = {
      kind: "pt-fbr-withholding-export-v1",
      export: Number(id),
      generatedAtUtc: f.record.at,
      generatedBy: { officer: officer.id, handle: f.record.officer },
      files: [{ name: f.fileName, bytes: f.csv.length, rows: f.rows, sha256: f.sha256 }],
      exportRecord: { opsAuditEntry: f.record.audit, opsAuditHash: f.record.auditHash },
      note: "Withholding statement data for a manual FBR filing. Contains full CNICs: confidential, never e-mail or store unencrypted. Amounts in PKR; format LEGAL/TAX TO CONFIRM.",
    };
    const files = [
      { name: f.fileName, data: new Uint8Array(f.csv) },
      { name: "manifest.json", data: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`) },
    ];
    const zip = zipStore([...files, { name: "SHA256SUMS", data: new TextEncoder().encode(sha256sums(files)) }], new Date(f.record.at));
    return new NextResponse(Buffer.from(zip), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="fbr-withholding-export-${id}.zip"`,
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
