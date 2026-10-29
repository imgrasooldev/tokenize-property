import type { Metadata } from "next";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { StepUpForm } from "@/components/StepUp";
import { pkt } from "@/lib/format";
import { requirePage } from "@/lib/server/session";
import { vaultConfigured, vaultObjects } from "@/lib/server/vault";

export const metadata: Metadata = { title: "Document vault" };

/**
 * The encrypted document vault (ADR 0017): the latest stored documents and whether each is
 * published (offering documents, risk disclosure, public property documents of a showable offering);
 * operations makers store a document with a security-key step-up. The portal never sees a key.
 */
export default async function DocumentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("operations.read", "/documents");
  const q = await searchParams;
  const rows = await vaultObjects(officer.sessionHash);
  const maker = officer.permissions.has("operations.request");
  return (
    <Shell officer={officer} current="/documents" title="Document vault">
      <Flash q={q} />
      {maker ? (
        <section className="card" aria-labelledby="up" style={{ marginBlockEnd: 16 }} data-testid="vault-upload">
          <h2 id="up">Store a document</h2>
          <p className="small mu">
            Encrypted by the vault service with its own key. Its SHA-256 is its name: store exactly the file whose hash the offering or property record shows, and it becomes
            downloadable on the website once published.
          </p>
          {vaultConfigured() ? (
            <StepUpForm csrf={officer.csrf} action="/api/documents/upload" upload>
              <label htmlFor="document">Document (PDF, JPEG, PNG or TIFF, up to 25 MB)</label>
              <input id="document" name="document" type="file" accept="application/pdf,image/jpeg,image/png,image/tiff" required />
              <div className="row">
                <button className="btn" type="submit">
                  Store with security key
                </button>
              </div>
            </StepUpForm>
          ) : (
            <p className="alert warn">The vault client is not configured on this portal (VAULT_CLIENT_SECRET_ADMIN; backend: npm run vault:setup).</p>
          )}
        </section>
      ) : null}
      <section className="card" aria-labelledby="list">
        <h2 id="list">Stored documents</h2>
        {rows.length === 0 ? (
          <p className="empty">The vault holds no document yet.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="t" data-testid="vault-objects">
              <thead>
                <tr>
                  <th scope="col">SHA-256</th>
                  <th scope="col">Type</th>
                  <th scope="col" className="n">
                    Size
                  </th>
                  <th scope="col">Stored</th>
                  <th scope="col">Published</th>
                  <th scope="col" className="n">
                    Reads
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.sha256}>
                    <td className="mono small" title={o.sha256}>
                      {o.sha256.slice(0, 16)}…
                    </td>
                    <td className="small">{o.media}</td>
                    <td className="n mono">{Math.ceil(o.size / 1024)} KB</td>
                    <td className="small">
                      {o.by} · {pkt(o.at)}
                    </td>
                    <td>{o.published ? <span className="chip ok">public</span> : <span className="chip">internal</span>}</td>
                    <td className="n mono">{o.reads}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Shell>
  );
}
