import { NextResponse, type NextRequest } from "next/server";
import { csvCell, sha256Hex, sha256sums, zipStore } from "@/lib/export";
import { decision } from "@/lib/server/approvals";
import { officerMessage, pgCode } from "@/lib/server/db";
import { seeOther } from "@/lib/server/http";
import { requireApi } from "@/lib/server/session";
import { ADDRESS, registerView } from "@/lib/server/trustee";

const MAX_LINES = 100_000;

/**
 * Evidence export of the trustee register next to the chain read model (ZIP: CSV, manifest.json,
 * SHA256SUMS), the audit export's pattern. All numbers come from one database snapshot pinned to
 * the indexer's cursor block. The export is recorded (trustee and admin audits, with the CSV's
 * SHA-256 and the pinned block) BEFORE the file is handed out; the manifest names those entries.
 */
export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => undefined);
  const officer = await requireApi(request, "trustee.export", form);
  if (!("sessionHash" in officer)) return officer;
  const raw = form?.get("token");
  const token = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const base = ADDRESS.test(token) ? `/trustee/register?token=${token}&` : "/trustee/register?";
  const back = (msg: string) => seeOther(`${base}error=${encodeURIComponent(msg.slice(0, 300))}`);
  // Only the page's own button asks for a file.
  if (form?.get("decision") !== "export") return back("Use the export button on the register page.");
  if (!ADDRESS.test(token)) return back("Choose a token.");
  try {
    const r = await registerView(officer.sessionHash, token, MAX_LINES);
    if (!r) return back("Unknown token.");
    const header = ["wallet", "register_units", "chain_units", "chain_minus_register", "differs"];
    const rows = r.lines.map((l) => [l.wallet, l.register, l.chain, l.difference, l.difference === "0" ? "no" : "yes"]);
    const csv = `${[header, ...rows].map((x) => x.map((v) => csvCell(v)).join(",")).join("\r\n")}\r\n`;
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
    const dataName = `trustee-register-${r.deployment.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40)}-${stamp}Z.csv`;
    const data = new TextEncoder().encode(csv);
    const sha = sha256Hex(data);
    const rec = await decision("SELECT admin.record_register_export($1, $2, $3, $4, $5) AS r", [officer.sessionHash, token, r.pinned?.block ?? null, rows.length, sha]);
    if (!rec.ok) return back(rec.error ?? "refused");
    const entry = rec as typeof rec & { trusteeAuditId?: number; auditId?: number; auditHash?: string; at?: string };
    const manifest = {
      kind: "pt-trustee-register-export-v1",
      token: r.token,
      deployment: r.deployment,
      pinnedBlock: r.pinned ? { number: r.pinned.block, hash: r.pinned.hash, indexerUpdatedAtUtc: r.pinned.updatedAt, halted: r.pinned.halted } : null,
      supply: r.supply,
      trusteeCap: r.cap,
      registerTotal: r.registerTotal,
      walletDifferences: r.differences,
      lines: rows.length,
      complete: rows.length === r.lineCount,
      generatedAtUtc: entry.at ?? null,
      generatedBy: { officer: officer.id, handle: officer.handle },
      files: [{ name: dataName, bytes: data.length, sha256: sha }],
      exportRecord: { trusteeAuditEntry: entry.trusteeAuditId ?? null, adminAuditEntry: entry.auditId ?? null, adminAuditHash: entry.auditHash ?? null },
      note: "Register = the trustee's own entries (V18 confirmations and two-officer adjustments); chain = the indexer's read model at the pinned block.",
    };
    const files = [
      { name: dataName, data },
      { name: "manifest.json", data: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`) },
    ];
    const zip = zipStore([...files, { name: "SHA256SUMS", data: new TextEncoder().encode(sha256sums(files)) }], new Date(entry.at ?? Date.now()));
    return new NextResponse(Buffer.from(zip), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="trustee-register-${stamp}Z.zip"`,
        "Cache-Control": "no-store",
        "X-Export-Audit-Id": String(entry.auditId ?? ""),
      },
    });
  } catch (e) {
    if (pgCode(e) === "PTS01") return back("Confirm with your security key first (step-up).");
    const msg = officerMessage(e);
    if (msg) return back(msg);
    throw e;
  }
}
