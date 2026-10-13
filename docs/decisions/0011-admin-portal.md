# ADR 0011: Internal portals, Step 6a foundation (officer authentication, roles, audit, exposure)

- Status: Accepted (owner approved Step 6 on 2026-10-13; reviewed, tested (129 unit/db + 183 authorization-matrix) and deployed by the lead 2026-10-13)
- Date: 2026-10-13
- Builds on: ADR 0001 (one Next.js app for the internal portals), ADR 0005 (maker-checker in the signer), ADR 0007 (payout gate), ADR 0009 (KYC status views, two-officer reviews), product map items 5 to 7
- Addresses: threats INF-2 (admin panel exposed), P-1 (single insider), P-3 (admin action without trace), K-5 (departing employee keeps access), API-1 (account takeover) for staff, and the new ones in the threat model section 4.11 (AD-1..AD-8)
- Migration: `backend/packages/db/migrations/0013_admin_portal.sql` (schema `admin`, rules P-1..P-9). Numbered after the website integration's `0012_website.sql` (Step 5h)

## Context

Steps 5c to 5h built every money and token rule in PostgreSQL, with maker-checker by "operator" names that the command line passes in. Nothing yet proves who an operator is. Before any approval moves into a web page, officers need strong identities, roles that cannot be combined unsafely, sessions that end on their own, and a tamper-evident record of everything they see and do. Standards: OWASP ASVS 5.0 level 3 for the admin panel, NIST SP 800-63B AAL3 for staff (security-standards.md section 1.2).

The internal portals are users 5 to 7 of the product map: operations, compliance and trustee officers, plus auditors. In Pakistan the trustee (e.g. CDC) is a separate regulated organisation, compliance answers to the FMU under the AML Act 2010, and the SECP expects segregation of duties and an audit trail it can inspect. Step 6a builds the foundation only; approvals (6b), compliance work (6c) and trustee work (6d) follow.

## Decision

### 1. One app, `admin/`, separate from the website

A new Next.js app (same versions as `web/`: Next 16.4, React 19.3, TypeScript 6.0.3 strict, eslint-plugin-security, zero warnings) on **127.0.0.1:3300**. Nothing is shared with the investor website at runtime: own process, own cookie name, own database login, no import of website code. Same nonce CSP as the website (script-src nonce + strict-dynamic, no inline scripts), plus stricter headers: `Cache-Control: no-store` everywhere, `Cross-Origin-Resource-Policy: same-origin`, `X-Robots-Tag: noindex`, Permissions-Policy allowing WebAuthn only in this document. A Host check in `src/proxy.ts` answers 421 to any other Host (DNS rebinding). Self-hosted OFL fonts (copied from the website). English only for now.

### 2. Authentication: WebAuthn hardware keys only (AAL3)

- **No passwords, no SMS, no e-mail links.** An officer signs in with a FIDO2 security key: discoverable credential (no user name typed), **user verification required** (PIN or biometric on the key), signature counter checked (a counter that does not increase is refused and raises `NOTIFY admin_alert`: possible cloned key).
- **Device-bound keys only.** The database refuses credentials that are backed up or multi-device (synced passkeys), so the key is the hardware an officer holds (AAL3). Attestation is requested (`direct`) and the AAGUID and format are stored; an allow-list of approved key models (FIDO Metadata Service) is a production setting to add before the pilot.
- **Library:** `@simplewebauthn/server` 14.0.3 and `@simplewebauthn/browser` 14.0.0, pinned exactly. Reasons: the most widely used maintained TypeScript implementation of WebAuthn Level 3 verification (attestation formats, COSE keys, origin and RP ID checks), MIT licence, no native code, no install scripts, `npm audit` clean; writing our own CBOR/COSE/attestation parsing would be a larger and riskier surface. The server keeps every ceremony state itself (below), so the library only verifies.
- **Ceremonies.** Each challenge (32 random bytes) is stored in `admin.challenges`, single use, at most 5 minutes old, bound to its purpose, to the browser by a short-lived `__Host-` ceremony cookie, and to the session (step-up) or the enrolment link (enrolment). The challenge is used up **before** the response is verified, so a failed attempt can never be replayed with it. Every failure is audited without personal data; anonymous ceremonies are rate-limited.
- **RP ID and origin.** WebAuthn needs a secure context and a domain name: production uses `https://<portal domain>`; the local machine and the demo server use `http://localhost:3300` (through an SSH tunnel). An IP address cannot be an RP ID, so `127.0.0.1` is refused with a hint.

### 3. Sessions and step-up

- The cookie `__Host-pt_admin` (Secure, HttpOnly, SameSite=Strict, Path=/, no Domain, browser-session) carries a random 256-bit token; the database stores only its SHA-256. **15 minutes idle and 8 hours absolute, enforced in the database** (`admin.authorize` ends the session and audits `session.expired`). One live session per officer: a new sign-in ends the previous one. Disabling an officer ends their session at once.
- **No plain-HTTP exception is needed** (unlike the website's `WEB_PLAIN_HTTP`): WebAuthn works only in a secure context, which is either HTTPS or `localhost`, and browsers accept Secure and `__Host-` cookies on `http://localhost`. The demo server is therefore used through an SSH tunnel at `http://localhost:3300` with exactly the production cookie. A flag that weakens the cookie was deliberately not added.
- **Step-up.** Signing in counts as a fresh assertion. Any approval needs a WebAuthn assertion less than **5 minutes** old recorded on the same session (`admin.record_step_up`). The check is in the database: `admin.require_step_up(session)` raises `PTS01`, and every approval function calls it inside its own transaction (in 6a: deciding officer changes; 6b to 6d reuse it for signer, payout, unfreeze, KYC and trustee decisions).
- **CSRF.** No Next.js server actions anywhere (a test enforces it). Every state change is a route handler that requires (1) `Origin` equal to the portal's origin, or `Origin: null` together with the browser-set `Sec-Fetch-Site: same-origin` (form navigations under `Referrer-Policy: no-referrer`); (2) a CSRF token derived from the session token (`sha256("pt-admin-csrf-v1|" + token)`), so it needs no extra secret and dies with the session; (3) SameSite=Strict on the cookie.

### 4. Officers, roles and segregation of duties (in the database)

| Role | May |
|---|---|
| `ops_maker` | operations overview, ops audit trails; prepares actions (6b) |
| `ops_checker` | the same; approves actions prepared by someone else (6b) |
| `compliance_officer` | overview, all audit trails, evidence export; KYC, sanctions, freezes, FMU reports (6c) |
| `trustee_officer` | trustee view only (6d) |
| `auditor` | read-only everything, evidence export, officer list (access reviews) |
| `admin` | officers and roles only, and the admin audit trail; never operations data, never approvals of money or token actions |

`admin.role_conflicts` lists 14 incompatible pairs; a trigger on `admin.role_grants` refuses a grant that conflicts with a current role **whoever writes the row** (also a superuser's direct INSERT), serialised per officer so two concurrent conflicting approvals cannot both pass. Maker and checker conflict; a trustee officer holds no platform role; an auditor holds no other role; an administrator holds no operations, compliance or trustee role; compliance never initiates (maker). The only allowed combination is **compliance officer + operations checker** (compliance as second line may check). The matrix is fixed by the migration: `admin.verify_audit()` compares it with a digest taken at migration time. Permissions per role are in `admin.role_permissions`; the portal's TypeScript copy (menus only) is tested to be identical.

Officers are their own population: nothing in `admin` refers to investors, and an investor website cookie never yields a session (tested).

### 5. Officer changes are maker-checker; bootstrap; enrolment links

- **Invite, grant, revoke, disable**: requested by one administrator, decided by a **different** administrator with a fresh step-up, with reasons; nobody requests or decides a change to their own account; requests expire after 24 hours; a change that would leave fewer than two active administrators is refused. Approval applies the change in the same transaction (the grant trigger checks segregation again).
- **Bootstrap**: `npm run officer -- bootstrap <handle> "<name>"` (on the server, database access needed) creates an administrator without a checker, **at most twice and only while no other officer exists**. Deviation from "only the very first administrator": with a single administrator no invitation could ever be approved (a checker must be a different administrator), so the ceremony creates two named administrators, each with their own key; after that bootstrap is closed for good. Both are marked `bootstrap` in the officer list and in the audit log. Recommended: two directors, witnessed by the trustee.
- **Enrolment links**: `npm run officer -- enrol-link <handle>` issues a one-time link for an officer whose invitation was approved (or a bootstrap administrator) and who has no key yet: 32 random bytes, printed once, only the SHA-256 stored, at most 30 minutes, single use, a new link revokes the old one. The token travels in the URL **fragment** (`/enrol#token=...`), which browsers never send to the server or in a Referer, and the page removes it from the address bar at once. The CLI drops to the database role `pt_admin_cli`, which can do nothing else.
- Lost key: disable and re-invite (maker-checker). A second (backup) key per officer is planned for 6b.

### 6. Audit

`admin.audit` is append-only (triggers) and hash-chained like the signer and reconciliation audits: `sha256(prev || "pt-admin-audit-v1" || [id, UTC time, actor, action, detail])`, timestamps formatted in UTC (finding F-04). Recorded: link issued, enrolment completed or failed, sign-in success or failure, counter regression, step-up, session expiry, logout, every page view of protected data, every access denial, every officer change requested or decided, roles granted and revoked, officers invited and disabled, every evidence export. `admin.verify_audit()` re-checks the chain and also finds rows written around the API: a credential without its enrolment entry (or with a swapped public key), a session without its sign-in entry, a grant, officer or change without its entries, a decided change edited afterwards, and an edited role matrix.

**Evidence exports** (compliance officer, auditor): a ZIP with the rows (CSV with formula neutralisation, or JSON), `manifest.json` (source, filters, rows, who, when, the chain verification result, the data file's SHA-256) and `SHA256SUMS` (checkable with `sha256sum -c`). The export is recorded in the admin audit, with the data file's hash, **before** the file is handed out; the manifest names that audit entry and its hash.

### 7. Database access: least privilege, read-only towards operations

The portal logs in as `pt_admin_web`, a member of **`pt_admin_portal` only**: no table grants at all, only EXECUTE on `admin.*` functions. Every read function takes the session hash and checks the permission itself (`admin.require`), so a page that forgot its check still gets nothing. The overview, audit and verification functions read the other schemas (`chain`, `outbox`, `signer`, `recon`, `anchor`, `kyc`, `bank`, `ledger`) as SECURITY DEFINER functions that return counts, health and audit rows only: no payloads, no hashes of personal data, no sealed data. Step 6a writes nothing outside schema `admin`. `pt_admin_cli` can only bootstrap, issue links and list; `pt_admin_auditor` can only verify.

### 8. Pages in 6a

Operations overview (chain health from Besu RPC: head, block time, QBFT validators and their last proposed block, peers; indexer cursor, lag and halts; outbox queue by status and the latest commands without payloads; pending signer approvals (count only); payout gate, last reconciliation run and its findings; anchors; KYC and bank queue counts; ledger journals). Audit trail (signer, reconciliation, ledger, admin) with filters, paging, live chain verification and export. Officers and roles (list, pending and decided changes, request form, approval with step-up, the segregation-of-duties matrix). My account (session limits, step-up, keys). Approvals (6b), Compliance (6c), Trustee (6d) are clearly marked placeholders without data.

### 9. Deployment exposure

Production: a separate host name, reachable only over the VPN, behind SSO in front of the portal (defence in depth; the portal's own WebAuthn stays mandatory), TLS, IP allow-list (threat INF-2). Demo server (owner decision, option A): `pt-admin.service` binds **127.0.0.1:3300** only, is **not** in nginx and the port is not opened in ufw; officers use `ssh -L 3300:127.0.0.1:3300` and open `http://localhost:3300`.

## Consequences

- Every later approval (6b to 6d) gets identity, segregation of duties, step-up and audit for free by calling `admin.require` and `admin.require_step_up` from its own database function.
- The backend's operator names (`signer.decide`, `recon.decide_unfreeze`, `kyc.decide_clearance`, `bank.decide_payout_batch`) will be bound to officer sessions in 6b, so a name can no longer be passed in freely.
- Two bootstrap administrators are needed to start, which is a ceremony to plan, not a technical limit.
- In-process rate limits assume one portal process (true behind the VPN or tunnel); several replicas need a shared store.

## Tests (Step 6a)

- Unit (13): route registry equals the files under `src/app`, no server actions, roles, tokens and CSRF, no open redirect, rate limits, filters, CSV injection, CRC-32, ZIP round trip and SHA256SUMS.
- Database rules (30): role matrix equals the TypeScript copy; every role pair at request time; the grant trigger against a forged approved change and a grant without a change; concurrent conflicting approvals (exactly one wins); maker-checker, own account, non-administrators, step-up older than 5 minutes (`PTS01`) and another officer's key, expiry, at least two administrators, disabling; bootstrap closed; link single use, revoked, expired, too long; synced passkey and missing user verification refused (audited); CLI and portal roles cannot use each other's functions; idle and absolute expiry, superseded session, logout, counter regression; the portal role has no table access and inherits only `pt_admin_portal`; audit completeness; append-only; tamper detection (edited entry, forged credential, swapped public key, forged session, edited role matrix, deleted entry, decided change edited).
- Database authorisation matrix (86): every portal function × every role and no session.
- HTTP authorisation matrix against the production build (183): every page and API route × six roles, anonymous and an investor website cookie; CSRF and same-origin on every mutating route; session expiry over HTTP; headers, Host check, export manifest checked against the audit entry; logout.
- End to end in Edge with a Chrome DevTools Protocol virtual FIDO2 key (3): enrolment from a link (single use), sign-in, step-up, sign-out; two administrators invite and approve with step-up; the new officer enrols, lands on the overview and is refused officer management; the admin chain is intact.

## Open items

1. AAGUID allow-list of approved hardware keys (FIDO MDS) and the SSO in front of the portal, before the pilot.
2. Backup key per officer and a key-replacement ceremony (6b).
3. Bind the backend's operator names to officer sessions (6b).
4. Alert wiring for `admin_alert` (counter regression) and for repeated sign-in failures.
5. Urdu UI (later; the investor website already has it).
