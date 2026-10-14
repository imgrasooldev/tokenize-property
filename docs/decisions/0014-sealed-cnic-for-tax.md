# ADR 0014: Sealed CNIC for tax (ATL checks and FBR filing exports)

- Status: Proposed (spec S-03, tasks T-023/T-024, migration `0021_operations_tax.sql`; awaiting lead and owner review, legal points below)
- Date: 2026-10-14
- Builds on: ADR 0009 (Y-1: peppered CNIC hashes, sealed name; this ADR amends Y-1 for tax use only), ADR 0011 (officers, step-up, maker-checker, audit), ADR 0005 / 0013 (one-time tickets and service-held keys)
- Addresses: S-03 open question Q-2 (filer status needs the CNIC), OP-41 (ATL check), OP-46 (withholding statements to FBR); threats D-2 (database dump leaks CNICs), insider misuse of personal data

## Context

FBR withholding depends on whether the investor is on the Active Taxpayers List (ATL), which is looked up by CNIC/NTN, and the withholding statements filed with FBR must name each withholdee by CNIC. Today the platform keeps no readable CNIC: ADR 0009 Y-1 stores only HMAC hashes under secret peppers, the last four digits, and the name sealed under the KYC data key. A hash cannot be reversed (by design), so neither the ATL check nor the filing is possible.

Options considered:

1. **Ask investors for ATL proof every year** (manual upload). No new key, but error-prone, slow, and the filing still needs the CNIC.
2. **Unseal through the KYC service** (store the CNIC under the KYC data key). Widens the KYC key's purpose; the KYC service would then hold every investor's name and CNIC readable together.
3. **A separately sealed CNIC under a tax-only key, opened only by the tax service** for two narrow purposes: the automated ATL check and an FBR filing export approved by two officers. (Chosen.)

## Decision

| Rule | What it guarantees |
|---|---|
| X-1 | **Separate key, separate holder.** The CNIC is sealed with AES-256-GCM under `TAX_CNIC_KEY_V<n>` (KMS/HSM in production), held only by the tax service (`npm run tax:serve`, `tax:atl`, `tax:enrol-cnic`). The KYC data key cannot open it; the tax key cannot open names. The database stores only ciphertext (`tax.sealed_cnics`) |
| X-2 | **Bound to the verified identity.** A CNIC is sealed only if one of its peppered hashes equals the subject's own `kyc.cnic_hashes` entry; a different CNIC is refused and audited. The associated data binds the ciphertext to subject, hash and pepper version, so it cannot be moved to another investor |
| X-3 | **Two purposes only.** (a) The ATL check: `tax.atl_due` releases ciphertexts to the tax service only, every release audited (`cnic.released`, purpose `atl_check`); the result is stored as status + ATL as-of date + SHA-256 of the provider's answer, never the CNIC. (b) The FBR filing export (X-4). No API, page, log or report returns a CNIC; the portal shows the last four digits at most |
| X-4 | **Two-officer, one-time filing export.** One tax officer requests (scope: token and periods, purpose, fresh security-key step-up); a different tax officer approves (step-up, digest of what was shown); within 24 hours one of the two gets a one-time ticket (2 minutes, only its hash stored) after another step-up. The portal hands the ticket to the tax service (HMAC client `admin-portal`, scope `/v1/filing-exports/generate` only), which redeems it, opens the CNICs in memory, builds the file and records its SHA-256 and row count **in the same transaction, before releasing it**. A ticket is used once; an export is generated once; no partial export (any line without a sealed CNIC refuses the whole file). The portal checks the digest and streams the ZIP (file + manifest + SHA256SUMS) with `no-store` |
| X-5 | **Audit.** Sealing, refusals, releases, requests, decisions, tickets and generation are in the hash-chained `ops.audit` (`ops.verify_audit()`), and portal actions also in `admin.audit` |
| X-6 | **Roles.** New officer role `tax_officer` (tax.read/decide/export; incompatible with ops maker, compliance, trustee, auditor and admin). Database role `pt_tax_service` is the only one that can redeem tickets or read sealed CNICs; the portal role and the operations role cannot |

## Consequences

- ADR 0009 Y-1 stays true for every other purpose; the CNIC becomes readable only to the tax service and only in the two flows above.
- Existing investors must provide their CNIC again for sealing (website or assisted form: **not built**, CLI `tax:enrol-cnic` reads it from stdin), or the KYC onboarding must hand it to the tax service once (not built). Until sealed, an investor is checked as **non-filer** (OP-41 fallback), which is the conservative withholding.
- The filing file contains full CNICs by necessity; handling it (encrypted storage, upload to FBR IRIS) is a manual, documented officer duty.
- The export does not contain names (the tax service cannot open them). If FBR's format needs the name, the KYC service must add it under the same ticket: an amendment to this ADR.

## Open (legal / owner)

1. Lawful basis under Pakistani data protection (PECA 2016, the draft Personal Data Protection Bill) to process the CNIC for ATL checks and filing: **LEGAL TO CONFIRM**.
2. FBR filing format (s.165 statement fields, IRIS upload, amounts in rupees) and retention period of filed data: **LEGAL/TAX TO CONFIRM**.
3. The real ATL source (FBR web service vs licensed intermediary) and its terms: task T-031.

## Verification

`backend/packages/tax/test/cnic-export.test.ts` (10 tests): wrong CNIC refused and audited; no readable CNIC (digits, dashed form or hex) in any tax, ops or admin audit row; ciphertext moved to another investor does not open; operations role cannot read sealed CNICs; ATL once per edition, 30-day validity, outage fallback flagged; requester cannot approve, a third officer cannot generate, stale step-up refused; file generated once over HMAC, SHA-256 recorded and equal; same ticket refused; missing CNIC refuses the whole file and leaves the ticket unused; expired ticket refused; nothing printed a CNIC. Admin: `test/db/operations.test.ts`, the DB read matrix and the HTTP matrix.
