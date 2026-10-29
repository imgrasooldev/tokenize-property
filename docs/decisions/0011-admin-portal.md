# ADR 0011: Internal portals, Step 6a foundation (officer authentication, roles, audit, exposure)

- Status: Accepted (owner approved Step 6 on 2026-10-13; reviewed, tested (129 unit/db + 183 authorization-matrix) and deployed by the lead 2026-10-13) Section 10 added for Step 6b (2026-10-13, migration 0016; reviewed and merged by the lead 2026-10-13). Section 11 added for Step 6c (migration 0019, merged). Section 12 added for Step 6d (2026-10-13, migration 0023; on branch `step-6d-trustee-portal`, awaiting lead review).
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

### 10. Step 6b: operations approvals (addendum, 2026-10-13, task T-004, migration 0016)

The portal shows pending work and carries officers' decisions to the backend authority that owns
them; it never decides anything itself, and its database role still cannot call a backend decision
function.

- **What is decided where.** Signing requests (ADR 0005): by the **signing service**. Payout batches
  (ADR 0009): `bank.decide_payout_batch` (maker-checker, payout gate, payability). Unfreeze requests
  (ADR 0007): `recon.request_unfreeze` / `recon.decide_unfreeze` (maker-checker, a run that passed
  after the freeze). S-01 requests: `property.decide_request` (duties, OB-SOD-1, expiry, guards). The
  portal reaches the SQL ones only through `admin.decide_*` / `admin.request_unfreeze`, which check
  the session, the permission and a step-up younger than five minutes (`admin.require_step_up`) and
  then call the backend function **under the officer's handle** in the same transaction. Refusals
  by the backend come back as `{ok: false, error}` and are audited (`approval.refused`).
- **Signer decisions via the signing service's HTTP API.** The portal has its own `@pt/http-auth`
  client `admin-portal` (secret `SIGNER_CLIENT_SECRET_ADMIN`, created by `npm run
  signer:admin-client`, never printed) with scope `/v1/requests/preview` and `/v1/decide` only; it
  can never ask for a signature. A decision is two steps: (1) `admin.issue_signer_ticket` checks
  session, `approvals.decide`, step-up, that the request's payload hash is the one the officer saw
  and that this officer may decide (not the requester, not a second approval by the same officer,
  still pending), then stores a one-time ticket (32 random bytes, only the SHA-256, 2 minutes, bound
  to session, request, decision, reason, payload hash and call hash); (2) the portal sends the
  decision with the ticket to the signing service, which recomputes the exact call from the request
  and the active policy, refuses if its hash differs from the one shown, and runs
  `signer.decide_officer`: the ticket is redeemed (the session, permission and step-up are checked
  again), `signer.decide` runs under the officer's handle, the outcome is recorded in both audits.
  Neither the portal nor the service can decide alone: the portal cannot run `signer.*`, the
  service cannot create tickets.
- **What you see is what you sign.** The detail page shows the call built exactly as the policy
  engine builds it at signing time (`backend/packages/signer/src/preview.ts`), with the arguments
  **decoded back from the calldata**, the selector, `to`, `from`, chain, gas limit, the policy rules
  and a live policy evaluation, plus the call hash (SHA-256 over request, kind, chain, policy id and
  version, from, to, data, gas and payload hash). Payout decisions are bound to the batch's items
  digest, unfreezes to the freeze they lift, S-01 decisions to the request digest; a mismatch is
  refused ("the request differs from what you reviewed").
- **Officer names are bound to sessions (open item 3 closed).** A signer approval, an unfreeze
  request or decision, or a payout batch created, decided or submitted under a portal officer's
  handle is refused by a trigger unless the admin function that checked that officer's session
  bound the name in the same transaction (`admin.decision_context`, writable by no backend role).
  Command-line operator names that are not officer handles keep working (break-glass), audited as
  before.
- **Permissions (role matrix changed, digest fixed again).** `approvals.read` (+ auditor),
  `approvals.decide` (operations checker), `approvals.request` (operations maker: ask for an
  unfreeze), `property.read` (maker, checker, compliance, auditor), `property.decide` (checker,
  compliance; the S-01 duty decides the rest).
- **S-01 duties linked to officers (S-01 refinement 10).** A duty needs a portal officer with a
  matching role: onboarding only for operations makers, compliance and senior compliance only for
  compliance officers, trustee only for trustee officers, due diligence and investment committee for
  any platform officer (maker, checker, compliance). `property.has_duty` also needs the officer to be
  active and still hold the role, so revoking the role or disabling the officer ends the duty at once.
- **Audit.** Every view of the inbox and of each item (`page.view` with the item's path), every
  ticket, decision, refusal and unfreeze request in `admin.audit`; the backend writes its own audit
  as before (`signer.audit`, `recon.audit`, `bank.audit`, `property.audit`).
- **Not in 6b.** Payout batch creation and submission stay with the bank service (record before
  send, bank file built from sealed IBANs); bank statement import, suspense returns, outbox review
  decisions and signer policy changes stay on the command line for now.

### 11. Step 6c: compliance portal (addendum, 2026-10-13, task T-005, migration 0019)

Numbered 0019: 0018 is reserved for work built in parallel (no dependency on it). Until 0018 is
merged the backend runner refuses the gap; tests use `contiguousMigrations()`.

- **Rules live in the new schema `compliance`** (C-1..C-8 in the migration header), reached by the
  portal only through `admin.*` functions that check the session, the permission and, for every
  decision, a step-up younger than five minutes, then bind the officer's handle (as in 6b).
- **KYC review cases.** A sanctions screening in `review` (possible match, or the new reason code
  `pep_match`) or `fail` (list hit) opens a case in the same transaction (trigger on `kyc.checks`);
  a newer screening supersedes the older open case. Officers open manual cases (standard or high
  risk). State machine in a trigger: open ↔ info_requested, open → pending_second → approved /
  rejected / open, open → approved / rejected (one officer, standard risk only), → superseded.
  High risk (PEP, sanctions, escalated) needs a proposer and a **different** confirmer, enforced by
  CHECK constraints on the row. For a screening match the decision **is** ADR 0009 Y-4
  (`kyc.request_clearance` / `kyc.decide_clearance`), so the KYC status stays derived in
  `kyc.evaluate`. A PEP is accepted only as the new clearance proposal `accept_edd` (enhanced due
  diligence, two officers); a list hit is final (Y-3) and is only closed as rejected. Rejecting a
  manual case revokes the verification (`kyc.revoke`; offboarding then freezes the wallet).
  Request-more-info is a state, not a message: contacting the investor is outside the portal (and
  must avoid tipping-off).
- **Freeze and unfreeze (spec change, ADR 0005/0009 amendment).** One compliance officer proposes
  with a reason code (`compliance.reason_codes`, freeze vs unfreeze codes enforced by a composite
  foreign key), a different one decides within 24 hours. An approved freeze places a
  `compliance.holds` row: `kyc.subject_status()` then reads **`suspended`** for a verified (or
  expired) investor (`kyc.underlying_status()` keeps the old derivation). Every gate that needs
  "verified" (signer, bank payouts, offering, property) therefore refuses a held investor, and the
  **existing** `compliance.freeze` policy (never a verified owner) signs the `compliance.freeze`
  command the approval enqueued in the same transaction (`compliance.freeze:request:<id>`, caseId =
  SHA-256 of the domain and request id). Unfreeze is the same two-officer path; it needs an active
  hold and an investor whose own status is `verified`, lifts the hold and enqueues the **new signer
  kind `compliance.unfreeze`** (`FreezeGuard.unfreezeAddress`), which the signing service signs only
  when `compliance.unfreeze_allowed(account, caseId)` confirms the decision, the owner is verified
  and the wallet is frozen (daily limit, same rule shape as freeze; policy approvals 0 because the
  two officers decided in the database). `suspended` is not in the offboarding list, so the
  offboarding worker never doubles a compliance freeze.
- **STR cases.** open → under_review → filed | close_proposed → closed (or back to under_review).
  Closing without a report needs a second officer; filing needs an export recorded first and the
  FMU reference. Notes append-only. Export = ZIP (case JSON with masked identifiers, notes,
  history; manifest; SHA256SUMS), recorded with its SHA-256 in `compliance.str_exports` and the
  admin audit **before** it is handed out; nothing is sent to the FMU automatically. Visible to
  compliance officers and auditors only; never changes the investor's status (tipping-off).
- **Re-screening** is queued in `compliance.rescreens` and executed by the KYC service
  (`npm run kyc:rescreen`, `RescreenWorker`), the only holder of the sealed-name key; failures are
  recorded by error name only.
- **Least data.** Reads show a short subject reference, the CNIC as `*****-****NNN-N` (last four
  only), the wallet, statuses and provider reason codes/scores/list versions; never names, hashes
  or evidence. Free text (reasons, summaries, notes) is refused by `compliance.free_text_ok` if it
  contains a CNIC, an IBAN or a Pakistani mobile number. URLs carry numeric ids only; investor
  references travel in POST bodies.
- **Officer names bound** (C-7): officer handles in `compliance.*` rows, `kyc.clearances` and
  `kyc.decisions` need the admin function on the stack (closes consequence 2 for KYC).
- **Permissions (role matrix digest fixed again).** `compliance.decide` and `compliance.export`:
  compliance officers only; `compliance.read`: compliance officers and auditors. Operations roles
  hold none. The compliance audit chain is a new audit source (`/audit/compliance`).
- **Dashboard.** Counts by state, SLA breaches from `compliance.sla()` (KYC open 48 h, second
  officer 24 h, info requested 7 d; freeze 4 h; STR open 3 d, under review 7 d, close proposed 2 d;
  re-screening 1 h), oldest open items, recent decisions.

### 12. Step 6d: trustee portal (addendum, 2026-10-13, task T-006, migration 0023)

Numbered 0023, on top of 0020 (S-06), 0021 (S-03) and 0022 (T-045): it keeps 0020's `recovery`
audit source and `legal_officer` role and 0021's `tax_officer` role in the shared registries and
fixes the role-matrix digest after all of them.

The trustee (e.g. CDC) is an independent regulated organisation. Its officers hold no platform role
(0013 role conflicts, unchanged). Rules live in the new schema `trustee` and in amendments of the
signer and offering rules (T-1..T-7 in the migration header); the portal reaches them only through
`admin.*` functions that check the session, the permission, a step-up younger than five minutes for
every decision, the digest of what the officer saw, and then bind the officer's handle (as in 6b).

- **Co-signing in the signer (T-1, ADR 0005 amendment, spec S-02 §8 amendment).** The specs assign
  the trustee to issuance: the Issuance Safe always includes a trustee signer (contract-spec §3,
  S-02 §3). `signer.trustee_cosign_kinds` lists the kinds (today `issuance.mint`). A request of such
  a kind that needs platform approvals (amount above the policy's `approvalAbove`) gets
  `trustee_approvals_needed = 1` from a trigger on insert: the service cannot opt out (deny by
  default), and the value never changes. An approval's `capacity` (platform | trustee) is set by a
  trigger from the approver's role, never by the caller. `signer.decide` counts the two capacities
  separately and approves only when both are complete; a trigger re-checks the
  `pending_approval -> approved` transition, so even a direct UPDATE cannot skip the trustee. A
  platform checker cannot add a third platform approval in place of the trustee, and a trustee
  officer is refused on a request that needs no trustee. Requests already waiting when the
  migration runs need the trustee as well.
- **Trustee decisions through the 6b path (T-2).** A co-signature is a one-time ticket of capacity
  `trustee` (`admin.issue_trustee_ticket`: `trustee.decide`, step-up, payload hash, blockers), redeemed
  by the signing service exactly like a 6b ticket after it recomputed the call and compared the call
  hash (call preview equal to the signed calldata). Redeeming a trustee ticket needs `trustee.decide`
  again. The outcome is recorded in the signer, admin and trustee audit chains.
- **Offering requests (T-2).** S-02 requests whose rule needs the `trustee` duty (L3, L7, L8,
  L10..L16, SD, the issuance batch IB and the completion record CMP, which carries the registered
  sale deed and the completion payment batch file hash) are voted by trustee officers in the portal:
  `admin.decide_offering_request` runs `offering.decide` under the officer's handle. For a portal
  officer the trustee duty is the `trustee_officer` role (active); a trustee officer holds no other
  offering duty (OF-SOD-4, trigger on `offering.duties`); votes under an officer's handle need the
  officer's session (binding trigger on `offering.request_votes`). Names that are not portal
  officers keep the 0015 command-line duties (break-glass; open item 12).
- **Distribution review (T-3, spec S-03 D4/D6 amendment).** While a distribution is `published` in the
  read model and inside the 48-hour challenge window counted from its publish block's time (the
  contract's `CHALLENGE_WINDOW`), a trustee officer approves, stating the Merkle root they recomputed
  independently (it must equal the published root), or rejects with a reason. One decision per
  distribution. **A rejection blocks finalisation in SQL**: triggers refuse a payout batch
  (`bank.payout_batches`) and the `rent:distribution:<token>:<id>` ledger journal for it, whatever
  the chain says; `trustee.distribution_blocked(token, id)` is the hook for any later finalise path.
  The on-chain `reject(id, reason)` stays a Trustee Safe transaction (never sent by the portal); the
  overview counts rejections not yet seen on chain.
- **The trustee's register (T-4).** `trustee.register_entries` is the trustee's own append-only unit
  register per wallet: written by a trigger when the trustee confirms an offering's register entries
  (V18, subscription `active`, + units; `redeemed`, - units) and by two-officer adjustments (opening
  balances, corrections) with the evidence's SHA-256 (proposer != decider, 72 hours, one open
  adjustment per wallet, no balance below zero). Existing active subscriptions are backfilled.
- **Reads (T-5).** The register next to the holders in the read model, both read in one database
  snapshot and pinned to the indexer's cursor block (number, hash, halt state), supply against the
  trustee cap and against the register total, differences first and highlighted; export (CSV,
  manifest, SHA256SUMS) recorded with its SHA-256 and the pinned block in the trustee and admin audits
  before release (pattern of the audit export). Co-signing queue (signing and offering), distributions
  with their window, daily reconciliation report (runs per day in PKT, latest runs, findings, run
  digest, payout gate), recovery requests (RecoveryGuard requests from the read model; S-06 case
  files through the hook `trustee.recovery_cases_json()`, which S-06 replaces). The trustee audit
  chain is a new audit source (`/audit/trustee`).
- **S-03 duties (T-8, on 0021's operations path).** An expense or fee above `expense_ops_limit_paisa`
  is approved by the trustee in the portal before the operations checker may approve it (OP-21, E1;
  `ops.decide_charge` replaced: it now asks the trustee instead of refusing; a trigger guards the
  approved state). A distribution calculation is approved by the operations checker only after the
  trustee's pre-check (D4): an independent recomputation of the Merkle root equal to the attached
  root, with the statement hash recorded (trigger on `ops.distributions`). A trustee rejection of the
  on-chain distribution (T-3) also refuses S-03's `rent:wht:<token>:<id>` journal, so
  `ops.book_distribution` cannot book a rejected distribution at all. Pages
  `/trustee/cosign/charge/[id]`, `/trustee/cosign/calculation/[id]`; the operations pages show the
  trustee's part (`admin.operations_charge`, `admin.operations_distribution` replaced).
- **Recovery cases (T-9).** `trustee.recovery_cases_json()` returns 0020's wallet-recovery and
  succession cases (kind, state, wallets, units, objection window, approvals by capacity, the
  on-chain request) to the trustee read-only. A trustee approval capacity in 0020's case decisions
  (S-06 C4) is not built (open item 16).
- **Permissions (T-7, role matrix digest fixed again).** `trustee.decide` (trustee officers),
  `trustee.export` (trustee officers and auditors), `trustee.read` (both, from 0013), `audit.export`
  for trustee officers (only the trustee chain is readable to them).

### 13. The remaining officer votes (addendum, 2026-10-22, task T-046, migration 0026)

Every vote the S-01 and S-02 workflows need from an officer can now be cast in PT Control, so the
demo catalogue (`seed:catalog`) and real operations reach an approved offering without a single
officer-named action on the command line. Specs S-01 section 16 and S-02 section 18 changed first.
The pattern is 6b's (section 10): `admin.*` checks the session, the permission, a step-up younger
than five minutes and the digest of what was shown, then runs the backend's own function under the
officer's handle in the same transaction; the backend keeps every business rule.

- **Investment committee (S-01 P7, OB-33).** `/committees` lists open meetings, files ready for a
  meeting (due diligence complete, `property.p7_problem` empty) and the latest outcomes;
  `/committees/[id]` shows the file (reviews, valuations, the legal opinion's qualifications, current
  documents with SHA-256), the votes and the outcome so far. A committee member opens a meeting and
  chairs it (`admin.open_committee` -> `property.open_ic`); each member votes approve, reject or
  abstain with a reason, or records a conflict (`admin.committee_vote` -> `property.cast_vote`, the
  reason in the property audit chain as `ic.vote_reason`), bound to the file digest; the chair closes
  with the SHA-256 of the minutes (`admin.close_committee` -> `property.close_ic`), bound to the digest
  plus the votes. Quorum, independence, the majority rule, OB-SOD-1 and "chair only" stay 0014's.
- **Trustee acceptance (S-01 P8, OB-37).** `/trustee/properties` (Legal Approved properties and the
  latest decisions) and `/trustee/properties/[id]` (structure with unit rights, planned register and
  holding limit, trust deed hash, the approving committee and its minutes hash, valuations, current
  documents). A trustee officer accepts or declines the latest structure with a reason and optional
  conditions (`admin.decide_property_trustee` -> `property.trustee_decide`), also recorded in
  `trustee.audit` (`property.accepted` / `property.declined`). New rule (S-01 §16): a structure is
  decided once; a declined one needs a new structure decision by the legal head.
- **Platform votes on S-02 requests.** `/approvals/offering` lists open requests that still lack a
  platform duty (offering checker, legal head, compliance, bank operator) and offerings pending
  approval whose L3 request lapsed; `/approvals/offering/[id]` shows the terms (price, units, window,
  use of proceeds, document hashes), the property, the votes and the missing duties. The vote runs
  `offering.decide` (`admin.vote_offering_request`), bound to `admin.offering_request_digest` (0023);
  an L3 request's offering can be returned to draft (`admin.return_offering` ->
  `offering.return_offering`). Trustee votes stay in Trustee > Co-signing (section 12).
- **Officer names bound (open item 3 closed for these records).** Triggers on `property.ic_votes`
  (insert), `property.ic_meetings` (status change) and `property.trustee_decisions` (insert) refuse an
  officer's handle unless the admin function that checked that officer's session bound it in the same
  transaction (`admin.decision_context`). With 0016 A-7 (S-01 duties only for portal officers) the
  committee and P8 decisions are portal-only. The `request_votes_officer_binding` of 0023 is unchanged.
- **Refusals carry the backend's SQLSTATE.** `admin.vote_refused` audits the refusal like
  `admin.refuse` and adds `state` (23514 guard, 23505 duplicate, 42501 forbidden, 22023 input,
  P0002 unknown), so callers and tests can tell a quorum refusal from a missing duty.
- **Permissions (role matrix digest fixed again).** `committee.vote` (operations makers and checkers,
  compliance officers: the roles allowed to hold committee duties); committees are read with
  `property.read`; `offering.read` (operations makers and checkers, compliance officers, auditors);
  `offering.decide` (operations checkers and compliance officers). P8 uses `trustee.read` /
  `trustee.decide`.
- **The demo path.** `seed:catalog` now lists, for every vote it stops at, the officer, the PT
  Control page and (for the close) the SHA-256 of the demo minutes file; it still never votes under
  an officer's handle and writes nothing while the same votes are due. A committee that did not
  approve or a structure the trustee declined stops it (`blocked`). The order of clicks is in
  `deploy/demo-server/README.md` and `docs/runbooks/portal-votes.md`. Reaching `ready` (L4) still
  needs the token deployed through DeployLib (paused, trustee cap set through the timelock) and the
  offering documents anchored in the DocumentRegistry; neither is a portal action.

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

## Tests (Step 6b)

- Backend: call preview equals the policy engine's calldata for every kind (5); officer decisions
  through the signing service's HTTP API end to end without a chain: a mint waits in the outbox, two
  checkers approve with tickets, the outbox proceeds and the request is signed; refusals for
  maker == checker, the same officer twice, a reused ticket, a stale step-up at issue and at
  redemption, a changed call, a non-checker, an officer name on the command line, wrong client
  scopes (5); payout batch gated by a frozen gate, unfreeze maker-checker after a passed run, officer
  names bound (2); S-01 request decided through the portal API with maker == checker refused by the
  backend, duties linked to roles, revoked role and disabled officer end duties (3).
- Admin database: authorisation matrix extended by 10 functions × 7 (70); portal role cannot reach
  any backend decision function or ticket; step-up for every decision; maker == checker end to end;
  ticket binding, expiry, single use, ended session; audit (8).
- HTTP matrix against the production build: 11 new routes × 8 callers, CSRF and same-origin on the 5
  new mutating routes, plus 4 flows with a real signing service (signer approval as shown, stale
  step-up, second approval refused, changed call refused; payout refused while frozen; unfreeze
  requested and approved after a passed run; views and decisions audited).
- End to end in Edge with virtual FIDO2 keys (2): two checkers approve a mint with their keys and the
  signing service decides; a maker asks for an unfreeze and a checker approves it after a passed run.

## Tests (Step 6c)

- Backend: KYC compliance rules through the portal's functions (13: PEP mock list, automatic
  cases, two-officer clearance and PEP acceptance, two-officer true match, list hit final, manual
  cases incl. info requests, escalation and revocation, supersede, CNIC/IBAN/phone refused, ops
  refused, stale step-up, officer names bound, portal role cannot reach `compliance.*`,
  re-screening worker incl. provider outage, audit tamper detection); signer freeze/unfreeze end to
  end (4: no policy, two-officer freeze → suspended → signed `freezeAddress`, forged unfreeze denied,
  two-officer unfreeze → signed `unfreezeAddress`, unfreeze refused for a revoked investor, chains
  verify); call preview for `compliance.unfreeze`.
- Admin database: matrix +20 functions × 7 callers (incl. audit source `compliance`); compliance
  rules (6: no table/function access, PTS01 on five decisions, KYC maker-checker and digest, freeze
  maker-checker and outbox command, STR close/file/export rules, audit).
- HTTP matrix: 8 new pages and 10 new POST routes × 8 callers, CSRF/same-origin on each, plus 4
  flows (masked identifiers only; two-officer KYC approval with stale step-up refused; freeze
  approved and queued; STR export recorded before release and matching its record).

## Tests (Step 6d)

- Backend: `signer/test/trustee-cosign.test.ts` (4: requirement set by the database and immutable,
  two checkers are not enough, trustee ticket redeemed by the signing service, changed call refused,
  roles cannot stand in for each other, officer handle refused on the command line, trustee first or
  last, trustee rejection final, kind without trustee, audit chains and a forged approval found);
  `offering/test/trustee.test.ts` (2: funding, issuance batch, completion record and register
  confirmed by portal trustee officers, the register follows V18 and equals the read model, duty
  rules OF-SOD-4); existing 6b tests extended with the trustee step (`officer-approval`, `service`,
  `e2e-chain`; web `invest`/`market` integration).
- Admin database: matrix +19 functions × 7 callers (incl. audit source `trustee`); trustee rules (8:
  no table/function access; distribution review permission, step-up, digest, recomputed root, one
  decision, window and status; rejection blocks payout batch and ledger journal; adjustments four
  eyes, digest, one open per wallet, no negative balance, expiry; register vs read model; export
  record; audit chain incl. tamper detection).
- HTTP matrix: 12 new pages and 7 new POST routes × 8 callers, CSRF/same-origin on each, plus 4 flows
  (two checkers and the trustee co-sign a mint as shown, stale step-up and changed call refused;
  distribution rejected and blocked; adjustment by a second trustee officer then the register
  matches and the export matches its record; no personal data on trustee pages, chains intact).
- End to end in Edge: the 6b mint flow now ends with a trustee officer co-signing in the trustee
  portal with a virtual FIDO2 key (5/5 passed, before the merge of 0020-0022; not re-run after).
- After merging 0020-0022 (2026-10-22): admin db +3 (OP-21 four steps, D4 pre-check rules, `rent:wht` block
  and recovery cases) and matrix +4 functions; HTTP matrix +2 pages, +2 routes; backend tax tests extended
  with the trustee steps. Totals: admin 893, HTTP 1048, backend 656 + 13 skipped.

## Tests (T-046)

- Backend: `offering/test/seed.test.ts` drives the demo catalogue to two approved offerings in a
  scratch database through the portal's own functions with real officer sessions (K4; committee
  votes and the chair's close incl. "no quorum" and "only the chair"; P8; three platform L3 votes and
  the trustee's), checks that the same votes from the command line are refused, that every
  officer-named vote has its `approval.decided` entry and that a final run writes nothing;
  `property/test/property-db.test.ts` P7/P8 rules now run through the portal (duplicate vote, no
  duty, quorum, chair only, Shariah certificate, decline final, command line refused); the property
  test world casts committee and P8 votes through the portal helpers in `db/test/officers.ts`.
- Admin database: matrix +12 functions x 9 identities; `test/db/votes.test.ts` (portal login cannot
  reach the backend vote functions or tables, step-up on all six votes, refusals audited with their
  SQLSTATE, officer handles refused by the binding triggers).
- HTTP matrix: 6 new pages and 6 new POST routes x 10 callers, CSRF/same-origin on each.

## Open items

1. AAGUID allow-list of approved hardware keys (FIDO MDS) and the SSO in front of the portal, before the pilot.
2. Backup key per officer and a key-replacement ceremony (moved to 6c).
3. ~~Bind the backend's operator names to officer sessions (6b).~~ Done in 0016 for signer approvals, unfreezes and payout batches; S-01 actors are linked to officers (role, active) but the property command line can still act under an officer's handle (break-glass, server access needed): bind it when the S-01 screens move into the portal. 2026-10-22 (T-046, 0026): bound for committee votes, the committee close and the trustee's P8 decision; K4/P-requests decided with `property.decide_request` and the makers' own S-01 actions (reviews, structure, documents) are not bound yet.
4. Alert wiring for `admin_alert` (counter regression) and for repeated sign-in failures.
5. Urdu UI (later; the investor website already has it).
6. Cross-check in `admin.verify_audit()` that every backend decision under an officer's handle has its `approval.decided` entry (today each chain verifies separately).
7. A signer policy that changes after an approval but before signing: the service signs with the new policy (as before 6b); consider re-checking the approved call hash at signing time.
8. (6c) Investor-facing wording of `suspended`, `review` and the PEP reason (tipping-off): the website shows KYC reasons today; compliance to confirm the generic text (also T-028 item 4).
9. (6c) Partial freezes (`freezePartial`), freezes of investors without a bound wallet, and assisted payout-account changes are not in the portal yet.
10. (6c) Real PEP list provider and FMU goAML format (T-031); SLA values are working defaults for the owner to confirm.
11. (S-06) Trustee-officer approval in the portal before `recovery.propose` (today the Trustee Safe's signature, OQ-3); no Playwright e2e for `/recovery` yet.
12. (6d) Trustee co-signature threshold: the trustee co-signs exactly the mints that need platform
    approvals (above `approvalAbove`); owner/trustee to confirm whether every mint (Issuance Safe
    2-of-3 incl. trustee) should need it, and whether the off-chain rule should equal the Safe's
    2-of-3 (today it is stricter: platform approvals plus the trustee).
13. (6d) Command-line offering duties for names that are not portal officers still work for the
    trustee duty (break-glass, server access needed); close before the pilot (trustee only through
    the portal). Votes under a portal officer's handle are refused outside the portal (enforced).
    `seed:catalog` (T-045) never casts a vote or decision under an officer's handle: it prepares everything up to the first vote (K4, investment committee, P8, L3), stops with outcome `waiting` and lists which votes officers must cast in PT Control (session + step-up), and writes nothing on a re-run while they are due. PT Control has screens for K4 (Approvals > Property & KYB) and the trustee's L3 vote (Trustee > Co-signing); investment committee votes, the P8 trustee acceptance and the non-trustee L3 votes have no screen yet, so the demo catalogue currently stops at the committee. 2026-10-22 (T-046, section 13): screens for the committee, P8 and the platform L3 votes exist; the demo catalogue reaches `approved` through PT Control.
14. (6d) The trustee register is the trustee's record inside our database; the trustee's own system
    of record (e.g. CDC) and a signed attestation feed (S-07 Q-2, recon `supply.register_mismatch`)
    are not wired yet.
15. (6d) The distribution review is recorded in our database; the Trustee Safe's on-chain
    `reject` and the Ops Safe's `finalize` are Safe-console actions (S-02 Q-8, T-039).
16. (6d) S-06 recovery cases are shown to the trustee read-only; the trustee's own approval before
    `recovery.propose` (S-06 C4, item 11) is not a capacity of 0020 yet; the Trustee Safe signs on chain.

## Addendum 2026-10-13: S-06 recovery, succession and reversal cases (T-026, migration 0020)

- New role `legal_officer` (conflicts with every other role). New permissions: `recovery.read` (operations makers and checkers, compliance, legal, auditors), `recovery.request` (operations makers: open cases, documents, heirs, the new wallet, refresh from chain), `recovery.decide` (operations checkers, compliance and legal officers: approve/reject in a capacity, cancel, release). The capacity must be one of the officer's roles and is checked again in SQL (`recovery.capacity_ok`). Role matrix digest re-fixed in 0020.
- Pages `/recovery`, `/recovery/[id]`; routes `POST /api/recovery/cases`, `/api/recovery/cases/[id]/evidence|wallet|act`, `/api/recovery/sync`; audit source `recovery`. Opening, setting the new wallet and every decision need a step-up younger than five minutes; decisions are bound to the case digest; officer handles are bound to sessions (`compliance.bind_actor`). The wallet route checks the case and the step-up before asking the signing service for a wallet.
- Landing page for an officer with `recovery.read` but no `ops.read` (legal officers): `/recovery`.
- Tests: `test/db/recovery.test.ts` (5), read matrix +10 functions × 8 identities, HTTP matrix +4 pages, +6 routes, +3 behaviour tests (hex hashes are now stripped before the CNIC-pattern check: a random digest once held 15 decimal digits in a row).

## Addendum 2026-10-22: S-05 exits and redemption windows (T-025, migration 0027)

- Permissions: `exit.read` (operations makers and checkers, compliance, legal and trustee officers, auditors), `exit.request` (operations makers: open a case, propose decisions, record proceeds and waterfall payments from statement lines, draft and submit the waterfall, announce the record date, propose redemption windows and their outcome, refresh from chain), `exit.decide` (operations checkers, compliance, legal and trustee officers). Role matrix digest re-fixed in 0027.
- Decisions are voted by capacity: the database takes the first open capacity the officer's role gives (`exit.decision_kinds`), refuses the proposer, the case's opener, a second vote of the same officer and a declared conflict, and checks the digest of what was shown. Operations checkers decide proceeds, payments, the final distribution and windows; the waterfall and the redemption batch are checked by an operations checker and approved by a trustee officer; the trustee pre-checks the final distribution with the root they recomputed.
- Functions: `admin.exit_overview`, `admin.exit_case`, `admin.exit_window`, `admin.exit_request` (maker actions), `admin.exit_decide` (decisions), `admin.exit_sync` (the tick); every write needs a step-up younger than five minutes, runs under the officer's bound handle, and refusals are audited (`approval.refused` with the SQLSTATE). Audit source `exit`.
- Steps that need keccak (calculation, statement, redemption refIds) run in the exit service CLI (`npm run exit:run`); the portal shows them and every decision around them.

## Addendum 2026-10-22: S-04 phase 0 transfers (migration 0028)

- Permissions `transfer.read` (operations maker and checker, compliance officer, trustee officer, auditor), `transfer.request` (operations maker: the transfer desk), `transfer.decide` (compliance and trustee officers), `transfer.cash` (operations maker prepares, operations checker confirms; the role is checked again in SQL), `transfer.price` (operations checker). Role matrix digest fixed again.
- Pages `/transfers`, `/transfers/[id]`, `/transfers/audit`; routes `POST /api/transfers/cases`, `/cases/[id]/desk|decide|cash`, `/sync`, `/prices`, `/conflicts`, `/links` (API_CONTRACTS section 8). Every decision binds the digest of the case shown and needs a fresh step-up; refusals are audited (`admin.refuse`). Surveillance alerts are shown only to holders of `compliance.read` (tipping-off). Officer names are bound to sessions on every transfer table (as 0016 A-3).
- The transfer audit chain is read through `admin.transfer_audit` (not a new source of `admin.audit_rows`, so this migration does not replace that function while S-05 builds in parallel).

## Addendum 2026-10-29: platform roles (T-049, migration 0031)

- Roles `platform_owner` (reads ops overview, approvals inbox, properties, offerings, operations, exit, transfers, officers and the ops/admin audit chains; `payouts.hold`; `support.read`), `property_manager` (`property.read`, `operations.read`) and `support_agent` (`support.read`). Role matrix digest fixed again.
- Segregation of duties: the platform owner conflicts with every deciding role, the auditor and the trustee (compatible only with `admin` and `support_agent`, so a "super admin" may also manage officers but never approve money); the property manager is an external fee payee and holds no other role; investor support holds no decision role and never compliance (no tipping-off).
- `admin.emergency_payout_hold` (step-up, reason, refusals audited) calls `recon.emergency_hold` (ADR 0007 amendment 2026-10-29). Route `POST /api/approvals/hold`; the form sits on `/approvals` for holders of `payouts.hold` while payouts are not frozen.
- `admin.support_lookup` answers one exact 8-hex reference; status values `verified`, `expired`, `pending`, `refer_compliance` (suspended, review, rejected, revoked); no name, CNIC beyond the masked last four, hold, case or reason; every lookup audited as `support.lookup`. Page `/support`.

### Addendum 2026-10-29: rent publication buttons (migration 0033, T-022)

- `/operations/distributions/[id]` shows, for an approved or booked calculation, where it stands on chain (`admin.rent_onchain`: publish command, on-chain distribution and window close, finalize command, and the reason each next step is refused now).
- An operations maker (`operations.request`, fresh step-up) asks for the next step with `POST /api/operations/distributions/[id]/rent` (`step` = `publish` | `finalize` | `book`) through `admin.rent_step`, which binds the officer's handle and calls only `ops.request_publish`, `ops.request_finalize` or `ops.book_distribution`: every 0021/0032 rule (approved calculation, one live publication, 48-hour window, trustee rejection, payout gate in the signer, finalized before booking) still decides. The on-chain distribution is found from the calculation; nobody types a registry or an id. Refusals are audited (`approval.refused`), successes as `operations.requested`.

### Addendum 2026-10-29: property managers scoped to their properties (migration 0034)

- A `property_manager` sees only the properties assigned to them (none until one is: deny by default). Assignments are maker-checker between two administrators (`officers.manage`, step-up, reason) on `/officers` (`POST /api/officers/scopes`, `POST /api/officers/scopes/[id]/decide`), audited as `manager_scope.requested|decided`, decided changes append-only.
- The reads a manager reaches are wrapped (`admin.<name>` checks the scope, `admin.<name>_all` is the unscoped original, no longer executable by the portal): operations periods, statement, charge, distribution, rent status, property requests, approvals inbox (property section), committees and committee. A token belongs to a property through its offering. Out-of-scope items read as not found; sponsor (KYB) requests stay hidden from managers. Other roles are unaffected.

### Addendum 2026-10-29: bank statement import (migration 0037)

- `/operations/bank` (operations.read): registered bank accounts and the latest 30 statements. An operations maker (`operations.request`, step-up) uploads one statement file (`POST /api/operations/bank`, multipart); the portal only reads the header and lines, `admin.import_bank_statement` binds the officer's handle and `recon.import_bank_statement` applies every R-5 rule again. Refusals are audited (`approval.refused`), imports as `operations.requested`. `StepUpForm` takes `upload` for multipart forms.

### Addendum 2026-10-29: bank desk and signing policies (migrations 0038, 0039)

- Suspense returns are maker-checker in the portal (`operations.request` asks, a different `operations.decide` approves; both step-up); the approval runs `bank.return_credit` under the checker's handle (payout gate applies). Requests are append-only once decided.
- Follow-up batches for held payouts are created by a maker for every held line whose investor now has an active payout account (`bank.create_followup_batch` checks again); the existing checker decision on `/approvals/payouts` follows.
- Signing policies: only new values for an existing kind with an active version, with exactly the same fields (a new kind or field stays a code change); maker proposes, a different checker activates, the proposer or a checker may withdraw. The signing service validates rules again when it loads them (deny by default) and loads them on start.

### Addendum 2026-10-30: S-01 maker requests bound (migration 0045)

- `property.requests` refuses a request under an officer's handle unless an admin.* function bound it (trigger `requests_officer_binding`). `/approvals/property` has an "Ask for a decision" form (`POST /api/approvals/property/request`, property.read + step-up); the S-01 duty rules decide who may ask. Property managers are never offered sponsor (KYB) files.

### Addendum 2026-10-30: complaints (migration 0040)

- New permissions `complaints.read` (support_agent, ops_maker, ops_checker, compliance_officer, auditor, platform_owner) and `complaints.handle` (support_agent, ops_maker); the role matrix digest is fixed again. `/complaints` and `/complaints/[id]`; `POST /api/complaints/[id]/act` (acknowledge, reply, resolve, refer; step-up; under the officer's handle). The investor appears by support reference only; a referral to compliance reads "under review" on the website.

