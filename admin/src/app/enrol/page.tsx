import type { Metadata } from "next";
import { EnrolClient } from "@/components/EnrolClient";

export const metadata: Metadata = { title: "Enrol security key" };

export default function EnrolPage() {
  return (
    <main className="auth">
      <section className="auth-card" aria-labelledby="t">
        <div className="key-art" aria-hidden="true">
          ⚿
        </div>
        <div>
          <h1 id="t">Enrol your security key</h1>
          <p className="mu">
            This one-time link works once and expires 30 minutes after it was issued. Have your FIDO2 hardware key and its PIN ready.
          </p>
        </div>
        <EnrolClient />
        <p className="small di">A device-bound key is required. Synced passkeys (cloud-backed) are refused for officers (NIST AAL3).</p>
      </section>
    </main>
  );
}
