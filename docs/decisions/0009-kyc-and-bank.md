# ADR 0009: KYC and bank (Raast payments, payout accounts, payout batches)

- Status: Proposed (owner approved the Step 5g plan 2026-10-12; awaiting lead review)
- Date: 2026-10-13
- Builds on: ADR 0003 (ledger), ADR 0007 (reconciliation and the payout gate), finding F-01 (never rely on claim revocation)
- Addresses: threats M-1 (payout redirected), M-3 (duplicate payout), M-5 (payment disputes), D-2 (database dump leaks CNICs and bank details), KYC-1 (fake or stolen CNIC), KYC-2 (sanctions screening part), new M-11 (forged or replayed bank notifications) and M-12 (third-party funding)

## Context

Until now the platform had no investor identity record and no bank side: the web prototype mocks NADRA inline, keeps its own `webdemo` tables and books money without a bank. Reconciliation (ADR 0007) can already compare the ledger with a bank statement, but nothing produced bank movements, and payouts had nowhere to go.

Real providers (NADRA Verisys, a liveness vendor, a sanctions list service, the trustee bank's Raast and payout APIs) need contracts we do not have yet. This step builds the platform side completely and puts every provider behind a narrow interface with a realistic mock, so the real adapters later replace the mocks without touching the rules.

## Decision

Two packages and one migration:

- **`@pt/kyc`** and schema **`kyc`**: identity checks and the investor's verification status.
- **`@pt/bank`** and schema **`bank`**: signed bank webhooks, payment codes, payout accounts, payout batches, and a **mock bank** that plays the outside party.
- **`0009_kyc_bank.sql`**: both schemas, roles, and every money and identity rule, enforced in PostgreSQL.

### KYC

Onboarding = NADRA Verisys, then liveness, then sanctions screening, stopping at the first failure (paid checks are not wasted on a rejected person). The **database derives the status** (`kyc.evaluate`); the service only records what the providers said.

| Rule | What it guarantees |
|---|---|
| Y-1 | **No readable personal data.** A subject is HMAC-SHA256 hashes of the CNIC and the name (keys = secret *peppers* held by the service: KMS/HSM in production), the last four CNIC digits, and the name sealed with AES-256-GCM (key outside the database) for re-screening. Provider responses are stored as SHA-256 evidence hashes; the provider keeps the record under its reference. A plain hash would not do: all 10^13 CNICs can be hashed in hours |
| Y-2 | One subject per CNIC. Peppers are versioned; after a rotation the service hashes under every active version, so a CNIC registered under an older pepper is still found |
| Y-3 | **Verified** needs a NADRA match, a liveness pass with score ≥ 80 (a table constraint: a pass below 80 cannot even be recorded) and a clear sanctions screening; for a new verification all three must be less than 30 days old; it lasts 365 days. A provider error is recorded but never verifies anyone and never removes a verification (an outage must not offboard investors). A sanctions hit is final |
| Y-4 | A **possible** sanctions match puts the subject in `review`. Only two different compliance officers can settle it (`false_positive` or `true_match`), with reasons; a request expires after 72 hours or when a newer screening arrives |
| Y-5 | Subjects, hashes, wallets, checks, decisions are append-only (clearances are decided once); hash-chained audit (UTC timestamps, finding F-04); `kyc.verify_audit()` also finds decisions changed afterwards and rows written around the API |
| Y-6 | Roles: `pt_kyc_service` registers and records checks; `pt_kyc_officer` decides reviews and revokes; `pt_kyc_reader`, `pt_signer` and the bank roles see the status only (`kyc.status`, `kyc.subject_status`, `kyc.is_verified`), never hashes or sealed data |

Losing a verification (re-screening hit, revocation, expiry) raises `NOTIFY kyc_alert`. The chain side must follow with a freeze and then offboarding through the timelock (finding F-01): **wiring this alert to the FreezeGuard is Step 5h**. `kyc.is_verified(wallet)` is the gate the registrar path will call before registering an identity on chain (5h).

### Bank

The **mock bank** keeps its own record of the trustee escrow account and talks to the platform only through signed webhooks, payout files and the daily statement. Reconciliation therefore compares two independent records, exactly as it will with the real bank.

| Rule | What it guarantees |
|---|---|
| B-1 | Webhooks are signed: `x-pt-bank-signature: t=<ms>,kid=<key>,v1=<HMAC-SHA256(secret, "<t>.<raw body>")>`, 5-minute window, two keys during rotation, 16 KB limit, strict JSON schema (unknown fields refused). An event id is recorded once: the same event again books nothing ("duplicate"), the same id with another body is refused (409) and alerts. Ten simultaneous deliveries book once (tested) |
| B-2 | Every credit is booked **in the same transaction** on `bank:trustee-escrow` with the Raast reference, so the statement reconciles line by line (ADR 0007 cash check). A credit is attributed to an investor only on an exact match: a known, unexpired payment code, the same amount, a verified investor, **paid from an account registered to that investor** (no third-party funding). Anything else goes to `bank:suspense`, never to an investor |
| B-3 | A payment code is paid once; a Raast reference is booked once (a bank re-sending the transfer under a new event id books nothing) |
| B-4 | Payout accounts: the bank's **account title must match the verified name** (keyed hashes compared in the database); an account can be the current payout account of one investor only; a new or changed account becomes usable **72 hours** after registration; every change alerts (`NOTIFY bank_alert`). The IBAN is stored as a keyed hash plus an AES-256-GCM copy bound to the investor (a copy moved to another investor fails to decrypt: tested) |
| B-5 | Payout batches are **maker-checker**, need the **reconciliation gate** (`recon.payouts_allowed()`) at approval **and** at submission, pay only verified investors through active, unchanged accounts, must equal a **finalized on-chain distribution's total** (read model), and are booked in the ledger in the submission transaction, where the ledger refuses paying anyone more than they are owed. Money back from suspense also needs the gate |
| B-6 | One live batch per distribution. The bank file is deterministic; its SHA-256 is recorded at submission (**record before send**). A retry after a crash rebuilds the same bytes and gets the same journal; the bank ignores the copy |
| B-7 | Append-only records, hash-chained audit, `bank.verify_audit()` re-checks booked credits and recomputes each batch's item digest. Roles `pt_bank_service`, `pt_bank_operator` (approves, returns suspense), `pt_bank_reader` (no hashes or ciphertext) |

A payout line returned by the beneficiary bank (account closed) puts the money back in escrow, makes the investor owed again, and retires that payout account until the investor registers a new one (72 hours again).

### Ledger conventions (added to ADR 0007's table)

| Journal key | Meaning | `external_ref` |
|---|---|---|
| `sub:<refId>:paid` | subscription paid (bank → investor's subscription account) | Raast reference |
| `bank:suspense:<raastRef>` | unattributed credit (bank → suspense) | Raast reference |
| `bank:return:<raastRef>` | suspense credit sent back (suspense → bank) | the same Raast reference (other direction) |
| `rent:collected:<token>:<period>` | rent received from the property manager (bank → `rent:pool:<token>`) | Raast reference |
| `rent:distribution:<token>:<id>` | distribution booked (`rent:pool:<token>` → `rent:payable:<subject>`) | statement hash |
| `rent:payout:<token>:<id>` | payout batch (payables → bank) | batch reference `PTPAY-…` |
| `bank:payout-return:<reference>:<line>` | returned payout line (bank → the investor's payable) | return reference |

On chain, `recordPayout(id, payoutBatchHash)` must use **`0x` + SHA-256 of the bank file** for a batch submitted through the bank service; reconciliation now checks this (`rent.payout_batch_mismatch`). The ADR 0007 mock convention (`keccak256(reference)`) remains only for batches without a bank file.

### Formats (mock, until the real bank's are known)

- Webhook events: `credit.received` (Raast reference, amount, value date, payer IBAN and title, narration with the payment code `PT-XXXX-XXXX`, Crockford base 32) and `payout.returned`. Schemas in `backend/packages/bank/src/service.ts`.
- Payout file `pt-mock-payout-v1` (JSON Lines: header with reference, debit account, total, count; lines with IBAN, bank code, amount and an 8-hex beneficiary reference; no names). `backend/packages/bank/src/payout-file.ts`.
- Statement: `pt-mock-bank-v1` from ADR 0007, produced by the mock bank.

### Commands and secrets

`npm run kyc:setup` and `npm run bank:setup` (local development only) append `KYC_PEPPER_V1`, `KYC_PEPPER_CURRENT`, `KYC_DATA_KEY`, `BANK_DATA_KEY` and `BANK_WEBHOOK_SECRET_K1` to the git-ignored `backend/.env.local`; `npm run bank` serves the webhook endpoint on 127.0.0.1:4910; `kyc:status`, `kyc:audit`, `bank:audit`. In production the peppers and data keys live in the KMS/HSM and are never in the database or in files.

## Tested (internally)

- KYC: 22 tests: onboarding paths, a scan of every `kyc` row for the CNIC, the name or its hex (Y-1), duplicates with and without dashes and across a pepper rotation, NADRA/liveness/sanctions outcomes, outage then retry, a liveness pass below 80 refused by the table, maker-checker clearance, a final sanctions hit, re-screening that removes a verification and alerts, revocation, append-only, a rogue administrator's edits found by `verify_audit`, roles.
- Bank: 37 tests: IBAN and signature cases (stale, future, edited, re-serialised, retired key), payment matching and every suspense reason, replay and conflict, ten concurrent deliveries, title mismatch, cooling-off, one account per investor, the full payout path with a bounced line, freeze between approval and submission, an account changed after approval, ledger refusal of an overpayment, a sealed IBAN swapped between investors, append-only, roles, the HTTP endpoint, and a **business day reconciled**: the mock bank's own statement, through the strict file format, imported into reconciliation, with **zero cash findings**; plus a property test (random mixes of exact, wrong-amount, unknown-code, third-party and repeated-code payments, redeliveries and lost deliveries): lost deliveries always show up as `cash.unmatched_bank_line`, and after the bank's retry the ledger equals the bank line by line.
- Mutation check: accepting a third-party payer, booking suspense without its reference, and dropping the cooling-off from `bank.active_payee` each make tests fail.

## Measured (this laptop, 2026-10-13, `npm run bank:bench -- 1000`)

| What | Result |
|---|---|
| KYC onboarding, three mock providers + database | p50 10.7 ms, p99 49 ms |
| Raast credit through the signed HTTP endpoint, booked in the ledger | p50 5.9 ms, p99 32 ms (97 credits/s sequentially, including creating each payment code) |
| Payout batch of 1,000 investors | create 0.66 s, approve 0.07 s, submit (bank file + ledger) 0.51 s; file 130 KB |
| Cash check on 1,001 statement lines | 19 ms, zero findings |

## Not in this step (honest gaps)

- **Real providers.** NADRA Verisys, liveness, sanctions (UN consolidated list, NACTA proscribed persons; PEP lists), the bank's Raast credit notifications, title fetch and payout API: contracts and onboarding are owner/partner work. Their real formats will change the adapters and the mock formats, not the database rules.
- **Record retention.** AML regulations require keeping customer identification records (including the CNIC copy) for years. They belong in a separate, encrypted document vault with its own access control (Step 6 or later), not in the operational database. Legal to confirm the retention period.
- **Officer and operator screens** for clearances, revocation, batch approval and suspense returns: Step 6 portals (SSO identities instead of typed names). Today they are database functions and TypeScript calls.
- **Chain side** of a lost verification (freeze, offboarding) and of a submitted batch (`recordPayout` with the file hash): Step 5h.
- **Held payouts.** A batch must cover the whole distribution, so one investor without an active payout account blocks the batch. A "held amounts" process (pay the rest, keep the held part owed) needs an on-chain convention: open question.
- **Name matching** is exact after normalisation (case, spaces, punctuation, Unicode forms). Common names mean title matching alone cannot prove ownership; the 72-hour cooling-off, one-account-per-investor and the change alerts limit the damage. A bank-side CNIC-to-account check (if the bank offers one) would close the gap: question for the bank.
- **Pepper rotation** of IBAN hashes: payout accounts must be re-registered after an IBAN pepper rotation (the CNIC lookup already handles rotation).

## Decisions on the open questions (2026-10-13)

The owner delegated these three ("jo munasib lage"); they follow the safer option and can be revisited by a new ADR.

1. **Who registers payout accounts: the investor, self-service only.** The investor enters the IBAN in the app after signing in; the bank's title must match the verified name; 72-hour cooling-off and an alert on every change (as built). Operators **cannot** register or change an investor's account: that is the classic insider redirect (M-1). An assisted change (investor lost their phone, branch visit) goes through the compliance portal (Step 6) as maker-checker by two officers, still with the 72-hour cooling-off and a notification to the old contact details.
2. **Held payouts: pay the rest, hold the share.** An investor without an active payout account (not registered, in cooling-off, account returned, KYC not verified) no longer blocks the batch. Their line is marked **held**: it is not sent to the bank and stays owed in `rent:payable:<subject>`. The batch records paid + held = the on-chain distribution total; the ledger payout journal covers the paid part only; reconciliation checks paid + held = on-chain total and that each held amount is still owed. A held share is paid later in a follow-up batch for the same distribution once the investor has an active account, with the same gate and maker-checker. Needs migration 0010 (0009 is already applied on the demo server) and a reconciliation change: **built in Step 5h**.
3. **KYC record retention: 10 years after the relationship ends**, as the starting assumption (Pakistan's Anti-Money Laundering Act 2010 and the SECP AML/CFT regulations require customer records to be kept for years after the relationship ends; **legal to confirm the exact period**). The CNIC copy, selfie and provider reports go to a separate encrypted document vault (Step 6 or later), never the operational database; hashes, decisions and audit chains in the database are kept for the same period.

## Consequences

- No investor money is attributed, and no payout leaves escrow, without the database's rules: exact matching, verified identity, cooling-off, maker-checker, the reconciliation gate and the ledger's balance checks.
- The bank's statement and the ledger can now be reconciled line by line from day one, including suspense credits, returns and bounced payouts.
- Personal data in the operational database is reduced to keyed hashes, last digits and sealed values; a database dump without the KMS keys reveals no CNIC, name or IBAN.
- Open questions for the owner: who registers payout accounts in production (investor self-service with the 72-hour cooling-off, or an operator); held-payout convention; the real bank's file hash definition (this ADR proposes SHA-256 of the submitted file); retention period for KYC records.
