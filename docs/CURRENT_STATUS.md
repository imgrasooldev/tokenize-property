# Current Status

Short handoff for the next session (rewritten 2026-11-23; the old per-branch notes were out of date). Read this and [TASKS.md](TASKS.md) first; [MEMORY.md](../MEMORY.md) holds decisions, gotchas and the communication log, [CHANGELOG.md](CHANGELOG.md) the history. Open other docs only when the task needs them.

## Where things stand

- Everything is on `main` (migrations 0001-0067). No open work branches: `app-push-dpop`, `phase-2a-app-invest` and `next-security-upgrade` are merged.
- Demo server `http://51.79.144.40` is live again on `main` (2026-11-23, after the owner renewed the OVH VPS that had expired on 2026-11-12). Renewal is manual: switching it to automatic renewal is the owner's call. `ubuntu` now has `loginctl enable-linger` so PostgreSQL keeps its shared memory when SSH sessions close (see MEMORY.md).
- Local run on one laptop: see "Run locally" below.

| Area | State |
|---|---|
| Contracts | 137 forge tests; internal review only, external audits pending |
| Chain | Four-validator Besu (`chain/net.py`, `chain/flow.py`) |
| Backend | 23 packages in `backend/packages/`: ledger, outbox + signing service, indexer, reconciliation, anchoring (local Anvil stand-in), KYC and bank mocks, offering (S-02), property onboarding (S-01), operations and tax (S-03), transfers (S-04), exit (S-05), recovery (S-06), notifications with push (FCM provider, needs the key on the server), document vault, public API |
| Website `web/` | Investor site on the outbox and signer (signs nothing); offerings, portfolio, demo market, rent proofs, `/verify`, `/exit`, `/transfers`, RDA sign-up, `/device`, `/confirm` for app requests |
| PT Control `admin/` | Officer portal (FIDO2, roles, maker-checker, audit): approvals, compliance (freezes, partial freezes, STR, monitoring, residency, offboarding), operations, trustee, tax, onboarding desk, health |
| Public API `/v1` | OpenAPI 3.1 contract `docs/api/openapi.json`; device grant, rotating refresh tokens, DPoP (RFC 9449); reads plus app requests the investor confirms on the website (invest, cancel, withdraw, market orders, order cancel, demo cash top-up) |
| App `mobile/` | Flutter, BLoC + repository, EN/UR, Night Glass and Daylight themes, push registration and DPoP proofs; APKs side-loadable; **never run on a phone yet** |

## Last test evidence (home laptop, 2026-11-23, Next.js 16.4.6)

| Suite | Result |
|---|---|
| web `npm run check` | 390 / 390 (chain running) |
| admin `npm run check` | 1911 / 1911 |
| admin `e2e/residency.spec.ts` | 1 / 1 (new; residency reviews by two officers) |
| web `npm run test:e2e` | 21 passed + 1 skipped; `market.spec` "trade settles" timed out once while the local dev stack also ran, then 2/2 alone |
| backend `npm run check` | 943 + 1 skipped on 2026-11-05 (later parts were tested by the session that built them; see the MEMORY log) |
| app `flutter test` | 33 passed (2026-11-19, Flutter 3.44.5 in `D:\pt-tools`) |

## Run locally

1. `python backend/scripts/pg.py start` and `python chain/net.py start`.
2. After a pull: `npm ci --ignore-scripts` in `backend/`, `web/`, `admin/`; then `cd backend && npm run migrate`.
3. Backend services (each in its own terminal or in the background): `npm run indexer`, `signer` (4900), `outbox`, `kyc:serve` (4910), `public-api` (4960), `bank:payees` (4920), `notify:run`, `demo` (console 4800). `bank:payees` and `notify:run` need `npm run bank:setup` / `notify:setup` once per machine.
4. `cd web && npm run dev` (http://127.0.0.1:3100) and `cd admin && npm run dev` (http://localhost:3300; 127.0.0.1 answers 421 by design).
5. `python scripts/demo.py up` starts only the chain, PostgreSQL, the website and the console, not the backend services of step 3.

## Waiting on the owner

- OVH: bring the demo VPS back (above).
- Firebase: place the FCM service-account key on the server (push is off until then).
- A phone run of the app (invest, cancel, withdraw, market order, top-up, push).
- Production domain and TLS (passkeys in the app, iOS build, store release).
- Decisions in MEMORY.md section 7: GPL-3.0 review of ERC-3643, which public L2, auditor rulings, retail limits; plus SECP/SBP permissions, real providers (NADRA, bank/Raast, SMS, e-mail), HSM/MPC vendor, legal texts still marked DRAFT and placeholder thresholds.
- Enrol the 14 demo officers (one security key each) so `seed:catalog` completes.

## Known issues

- CI job `web-e2e-chain` is informational (`continue-on-error`) until it has passed on GitHub several times.
- Load-sensitive tests: `market.spec` (website e2e) and the ledger timing test can time out on a busy laptop; rerun alone before suspecting a regression.
- firebase_messaging 17 deprecates `getToken` / `onTokenRefresh`; the app keeps them because the server sends to the token. Moving to installation ids needs a server change.
- Auto-reinvest is on hold (owner).
