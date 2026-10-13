# PT Control: internal portals (Step 6)

One Next.js app for operations, compliance, trustee and audit officers (product map items 5 to 7).
Design: the v2 suite (`docs/design/v2-suite/ops-*.html`) with the density of `mockup-home-v7`.
Decisions and rules: [ADR 0011](../docs/decisions/0011-admin-portal.md). Threats: section 4.11 of the
[threat model](../docs/threat-model.md) (AD-1..AD-8).

## Status

| Sub-step | Scope | Status |
|---|---|---|
| 6a | Foundation: WebAuthn hardware keys, sessions and step-up, roles with segregation of duties in the database, hash-chained admin audit, operations overview, audit trails with evidence export, officer management (maker-checker) | Built |
| 6b | Approvals: signer requests, payout batches, unfreezes, outbox reviews (by officer sessions with step-up) | Planned (placeholder page) |
| 6c | Compliance: KYC reviews, sanctions, freezes and offboarding, FMU reports | Planned (placeholder page) |
| 6d | Trustee: register, co-signing, distribution review | Planned (placeholder page) |

## Run locally

PostgreSQL must be running (`python backend/scripts/pg.py start`); the chain is optional (the overview shows it as down).

```bash
cd admin
npm ci --ignore-scripts
npm run setup:local                                  # database pt_admin_dev (all migrations), login pt_admin_web, admin/.env.local
npm run officer -- bootstrap ana.admin "Ana Admin"   # prints a one-time link (30 min); run once more for a second administrator
npm run dev                                          # http://localhost:3300 (NOT 127.0.0.1: WebAuthn needs the localhost origin)
```

Open the printed `http://localhost:3300/enrol#token=...` link, register a FIDO2 security key (with PIN),
then sign in. Further officers: one administrator requests the invitation on **Officers & roles**, a
second approves it (the browser asks for the key again: step-up), then on the server
`npm run officer -- enrol-link <handle>` prints that officer's link. `npm run officer -- list` and
`npm run officer -- verify` (admin audit chain) help operators.

`pt_admin_dev` never touches the demo database `property_token`. For real data in the overview,
index the local chain into it (`PG_DATABASE=pt_admin_dev INDEXER_DEPLOYMENT_FILE=... npm run indexer` in
`backend/`) and run a reconciliation (`... npm run recon -- --no-verify`).

## Security model in one page

- **Sign-in:** hardware security keys only (FIDO2, user verification, device-bound; synced passkeys refused). No passwords.
- **Session:** `__Host-pt_admin` cookie (Secure, HttpOnly, SameSite=Strict) with a random token; the database keeps its hash and ends it after **15 min idle / 8 h**; one session per officer.
- **Step-up:** every approval needs a fresh key assertion (< 5 min), checked by the database (`admin.require_step_up`).
- **Roles:** `ops_maker`, `ops_checker`, `compliance_officer`, `trustee_officer`, `auditor`, `admin`; 14 incompatible pairs refused by a database trigger; administrators manage officers only.
- **CSRF:** no server actions; route handlers check the origin (or `Origin: null` + `Sec-Fetch-Site: same-origin`) and a session-bound CSRF token.
- **Database:** the portal's login is a member of `pt_admin_portal` only (no table grants, EXECUTE on `admin.*`); every function re-checks the session and permission; read-only towards the operational schemas.
- **Audit:** every sign-in, step-up, page view, denial, officer change and export in the hash-chained `admin.audit`; exports carry a SHA-256 manifest naming their audit entry.
- **Exposure:** binds 127.0.0.1:3300; production behind VPN + SSO + TLS; the demo server only through `ssh -L 3300:127.0.0.1:3300` (never nginx).

## Tests

```bash
npm run typecheck && npm run lint          # strict TypeScript, 0 warnings
npm test                                   # unit (13) + database rules (30) + database authorisation matrix (86)
npm run build && npm run test:http         # HTTP authorisation matrix against the production build (183)
npm run test:e2e                           # Edge + virtual FIDO2 key: enrolment, sign-in, step-up, maker-checker, sign-out (3)
ADMIN_E2E_DB=pt_admin_dev SCREENSHOTS=1 npm run test:e2e -- screens   # 1440 px screenshots with real data into screenshots/
```

Database tests create and drop their own `pt_scratch_admin_*` databases. The HTTP matrix starts
`next start` on port 3399 (set `ADMIN_HTTP_DIST=.next-http` after `NEXT_DIST_DIR=.next-http npm run build`
to keep a dev server's `.next` untouched). The end-to-end run starts `next dev` on 3301 with its own
build folder `.next-e2e` and database `pt_admin_e2e` (re-created each run).

## Gotchas

- Open `http://localhost:3300`, not `127.0.0.1`: an IP address cannot be a WebAuthn RP ID, so the portal answers 421 there.
- `next build` rewrites `next-env.d.ts`; restore it before committing (as in `web/`).
- A changed (uncommitted) migration needs `npm run setup:local -- --fresh`: the runner refuses changed checksums.
- With `Referrer-Policy: no-referrer`, browsers send `Origin: null` on form posts; the portal accepts that only with `Sec-Fetch-Site: same-origin`.
- `next dev` compiles each route on first use (tens of seconds); the end-to-end specs warm every route first.
- Buttons that start a WebAuthn ceremony stay disabled until React has hydrated, so a click is never lost.
