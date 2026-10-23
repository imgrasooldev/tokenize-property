# Database Design

- Audited commit: `main` @ `41241b3` (2026-10-13). Derived only from the SQL in `backend/packages/db/migrations/0001`-`0011` and the runtime DDL in `web/src/lib/server/db.ts`. Rule IDs are the ones written in the migration headers.
- Engine: PostgreSQL 18. Databases: `property_token` (app) and `property_token_test` (tests). Which migrations are applied to which local database is **Unknown** from code (MEMORY.md §5 records it per migration).

## 1. Migration system

- Runner: `backend/packages/db/src/migrate.ts` (`npm run migrate`, `-- --test` for the test DB). Each file runs in its own transaction under a session advisory lock; applied names and SHA-256 are stored in `public.schema_migrations`; a changed applied file fails with "checksum mismatch".
- Rules (Verified from code and migration comments): never edit a committed migration; add the next number; numbering has no gaps; later fixes use `CREATE OR REPLACE` or additive DDL (`0008`, `0010` header comments say so explicitly).
- **Exception:** schema `webdemo` is created at runtime by the website (`CREATE ... IF NOT EXISTS` and `ALTER ... ADD COLUMN IF NOT EXISTS` in `web/src/lib/server/db.ts`), outside this system (task T-008).

## 2. Schemas

| Schema | Created in | Purpose |
|---|---|---|
| `ledger` | 0001, tables 0002, 0008 | double-entry money and token records |
| `outbox` | 0001, 0003 | chain commands |
| `signer` | 0001, 0004, 0008 | signing policies, requests, approvals, nonces, audit |
| `chain` | 0001, 0005 | read model built by the indexer |
| `recon` | 0001, 0006 | reconciliation runs, findings, gate, bank statements |
| `anchor` | 0007 | public anchors |
| `kyc` | 0009 | investor identity subjects, checks, decisions |
| `bank` | 0009, 0010 | bank events, credits, payees, payout batches |
| `property` | 0014 | sponsors (KYB), properties, documents, duplicate checks, reviews, valuations, committee, structure, trustee acceptance (spec S-01) |
| `offering` | 0015 | offerings, subscriptions, document acceptances, maker-checker requests, issuance batches, completion records, refunds (spec S-02) |

| `property` | 0014 (branch `t-021-property-onboarding`, not on `main`) | sponsors (KYB), properties, documents, duplicate checks, reviews, valuations, committee, structure, trustee acceptance (spec S-01) |
| `notify` | 0017 (branch, task T-028) | notification recipients, sealed contacts, preferences, templates, notifications, deliveries, attempts, rate limits, audit (ADR 0013) |
| `webauth` | 0024 (task T-030) | investor passkeys, website sessions, WebAuthn challenges, step-up settings, hash-chained audit |
| `webdemo` | runtime DDL (web) | prototype investors, subscriptions, top-ups, orders, trades |

`0001` revokes `CREATE` on `public` and all rights on the five first schemas from `PUBLIC`.

## 3. Tables per migration

### 0002 ledger (rules L-1..L-6)

| Table | Key columns and constraints |
|---|---|
| `ledger.accounts` | `code` unique, pattern `^[a-z][a-z0-9_]*(:[a-z0-9_-]+)*$`; `kind` asset/liability/equity/income/expense; `asset` code; generated `normal_side`; `allow_overdraft` default false |
| `ledger.journal` | `idempotency_key` unique (8-200 chars); `kind`; `memo`, `external_ref`, `created_by`; `payload_hash`, `prev_hash`, `hash` (32 bytes, `hash` unique) |
| `ledger.postings` | `journal_id`, `account_id` FKs; `asset`; `amount` bigint, non-zero (positive = debit) |

L-1 every journal balances per asset; L-2 no UPDATE/DELETE/TRUNCATE (triggers); L-3 writes only via `ledger.post_journal` / `ledger.open_account` (SECURITY DEFINER); L-4 SHA-256 hash chain, `ledger.verify_chain()`; L-5 idempotency; L-6 no overdraft on protected accounts. Functions: `chain_head`, `digest`, `open_account`, `post_journal`, `verify_chain`.

### 0003 outbox (O-1..O-7)

| Table | Key columns and constraints |
|---|---|
| `outbox.commands` | `idempotency_key` unique; `kind` dotted lower-case; `payload` jsonb object <= 16 KB + `payload_hash`; `status` pending/claimed/submitted/confirmed/failed/review; `attempts`, `max_attempts` (1-20, default 5); lease (`lease_owner`, `lease_until`); tx (`tx_hash`, `tx_nonce`, `tx_from` all-or-none); submitted/confirmed need a tx hash; claimed/submitted need a lease |
| `outbox.command_events` | append-only history: `from_status`, `to_status`, `actor`, `tx_hash`, `detail` |

Functions: `enqueue`, `claim`, `record_submission`, `complete`, `release`, `resolve`, `extend_lease`, `operator_decide`, `stats`, plus `outbox.defer` (added in 0004).

### 0004 signer (S-1..S-5)

| Table | Key columns and constraints |
|---|---|
| `signer.keys` | `key_ref` PK, `address` unique, `purpose` (no key material: S-1) |
| `signer.policies` | (`kind`, `version`) unique; `rule` jsonb; `approved_by <> proposed_by`; `retired_at` |
| `signer.requests` | uuid PK; `command_ref` unique; `kind`, `key_ref` FK, `payload` + hash, `policy_id`, `amount` numeric(78,0); `status` denied/pending_approval/approved/signed/broadcast/released/rejected/expired; `approvals_needed` 0-5; `expires_at` default +24 h |
| `signer.approvals` | PK (`request_id`, `operator`); `decision` approve/reject |
| `signer.nonces` | PK (`address`, `nonce`); `status` reserved/broadcast/released |
| `signer.audit` | hash-chained (`prev_hash`, `hash` unique); 0008 adds `digest_version` 1/2 |

### 0005 chain read model (C-1..C-7)

Tables: `deployments`, `contracts`, `cursors` (block, hash, halt state), `blocks` (number, hash, parent_hash), `halts` (halt/clear), `events` (raw logs), `tokens` (supply, trustee cap, paused), `holdings`, `transfers` (mint/burn/transfer), `issuances` (refId, mint/burn), `freezes`, `freeze_actions` (address/partial), `distributions` (published/rejected/finalized/paid, `payout_batch_hash`), `documents`, `recoveries` (wallet_recovery/forced_transfer; pending/executed/cancelled), `investors`. Amounts are `numeric(78,0)`.

C-1 one batch per `chain.apply_batch` call with compare-and-set cursor; C-2 parent-hash linkage; C-3 append-only history; C-4 writer calls only API functions; C-5 contract invariants re-checked (no negative balances, refId once, state machines); C-6 halted deployment refuses batches until `chain.clear_halt` (granted to nobody); C-7 `NOTIFY chain_events` on commit.

### 0006 recon (R-1..R-7)

Tables: `audit` (hash-chained), `runs` (running/passed/failed/error, `pinned_block`, blocking/warning counts), `findings` (blocking/warning), `gate_events` (freeze/unfreeze), `unfreeze_requests` (open/approved/rejected/expired, 24 h expiry), `bank_accounts`, `bank_statements` (opening, closing, digest), `bank_lines`.

R-2 blocking finding freezes in the same transaction; R-3 two-operator unfreeze bound to the current freeze, after a later passed run; R-4 `recon.payouts_allowed()` = not frozen AND latest run passed AND finished < 26 h ago; R-6 `recon.verify_audit()`.

### 0007 anchor (A-1..A-5)

`anchor.anchors`: chain IDs, contract, `besu_block`, `besu_block_hash`, `ledger_journal_id`, `ledger_head_hash`, `commitment`; `status` recorded/sent/confirmed/failed; tx fields and `raw_tx` stored before send. `anchor.history`: append-only actions record/sent/confirm/dropped/fail. A-2 never a lower block, ledger head never backwards, one open anchor per contract.

### 0008 review fixes (findings F-04..F-06)

- `signer.audit.digest_version` (v2 = UTC text); legacy rows verified under every UTC offset (`signer.legacy_row_matches`).
- `ledger.account_balances` (PK `account_id`, `balance`, `last_journal_id`): forward-only running balances updated inside `post_journal`; `ledger.verify_balances()` must return no rows.
- `IS DISTINCT FROM` validation in `post_journal` and `chain.apply_batch`.

### 0009 kyc and bank (Y-1..Y-6, B-1..B-7)

| Table | Key columns and constraints |
|---|---|
| `kyc.subjects` | uuid; `name_hash`, `name_enc` (sealed), `pepper_version` |
| `kyc.cnic_hashes` | `cnic_hash`, `pepper_version`, `subject_id` (one subject per CNIC across pepper versions) |
| `kyc.wallets` | `wallet`, `subject_id`, `bound_at` |
| `kyc.checks` | `kind` nadra/liveness/sanctions; `outcome` pass/fail/review/error; provider ref, score, list version |
| `kyc.decisions` | `status` pending/verified/review/rejected/revoked; `valid_until` |
| `kyc.clearances` | two-officer decision on a sanctions possible match; open/approved/rejected/expired |
| `kyc.audit`, `bank.audit` | hash-chained |
| `bank.events` | webhook `event_id` once, `key_id` |
| `bank.payment_intents` | `code`, `purpose` subscription/rent_collection, amount, ledger key, expiry |
| `bank.credits` | `raast_ref` once; `status` matched/suspense; `journal_id` |
| `bank.credit_returns`, `bank.payout_returns` | returns with journals |
| `bank.payees` | `iban_hash`, `iban_enc`, `active_from` (72 h cooling-off), `superseded_at` |
| `bank.payout_batches` | `reference`, token, `distribution_id`, `total_paisa`, `items_digest`; `status` created/approved/rejected/submitted; maker, checker; `file_sha256` (32 bytes) required exactly when `submitted` |
| `bank.payout_items` | (`batch_id`, `line_no`), subject, payee, amount |

The migration also opens ledger accounts `bank:trustee-escrow` (asset) and `bank:suspense` (liability).

### 0010 held payouts (H-1..H-4)

`bank.payout_batches` gains `kind` distribution/follow_up, `parent_id`, `paid_paisa` (0 < paid <= total), `items_digest_version` 1/2; `bank.payout_items` gains `held`. New `bank.create_followup_batch`; replaced `create_payout_batch`, `submit_payout_batch`, `batch_problems`, `payout_file_rows`, `verify_audit`.

### 0011 integration (I-1..I-3)

`bank.distribution_file_hash(token, distribution)` for the signer (I-1); `kyc.enqueue_offboarding(freeze_guard, actor)` with idempotency key `compliance.freeze:<subject>:<decision>:<status>` and advisory lock 586586099 (I-3).

### 0014 property (PR-1..PR-9; spec S-01, task T-021)

Numbered 0014 because 0012 (Step 5h) and 0013 (Step 6a) are on other branches; until they are merged the runner's no-gap rule refuses 0014 on a database built from this branch alone (the property tests use a renumbered copy, `backend/packages/property/test/helpers.ts`).

| Table | Key columns and constraints |
|---|---|
| `property.settings`, `doc_types`, `mandatory_documents`, `transitions` | configuration (LEGAL TO CONFIRM values; DocType mapping; KYB and property document lists; the only allowed transitions K1..K11, P1..P14 with their audit event names); no role writes them |
| `property.staff_duties` | duty per officer (onboarding, compliance, compliance_senior, legal, legal_head, valuation, technical, ic_member, ic_independent, trustee); requested and decided by two different administrators; a trustee holds no other duty (trigger) |
| `property.sponsors` | uuid; `kind` company/individual; `owner_subject` (KYC subject, individual); `legal_name_enc`, `address_enc` (sealed); `cuin_last4`, `ntn_last4`; `state` (moves only with an event) |
| `property.sponsor_identifiers` | keyed hash of CUIN/NTN/STRN per pepper version, unique (one sponsor per registration number) |
| `property.sponsor_persons` | KYC subject, role owner/director/representative/beneficial_owner, ownership in basis points, control basis, powers (submit/upload/respond/withdraw); ended once |
| `property.registration_checks`, `sponsor_screenings`, `risk_ratings`, `fmu_assessments` | SECP verification, company screening (clear/possible_match/hit), risk rating (high needs EDD evidence), FMU assessment (compliance only) |
| `property.sponsor_events`, `property_events` | the state logs; trigger `apply_event` refuses anything outside `transitions` or not from the current state; `checker`, `request_id`, `curable` (OB-16) |
| `property.properties` | OB-10 identifiers, area, GPS (inside Pakistan), use, occupancy, leases summary; generated `property_key` (OB-11) and `deed_key`; identifiers change only in Draft; `previous_id` links a curable resubmission (unique) |
| `property.documents`, `document_verifications` | SHA-256, size, media type, opaque store reference, uploader, representative; same bytes once per file; `supersedes` (unique, same type and file); verification at source (OB-21) |
| `property.duplicate_checks`, `duplicate_candidates`, `duplicate_decisions` | one check per submission (clear/possible/blocked, fraud flag), candidates (exact/possible/linked with reasons), one decision per officer and candidate (onboarding and compliance capacities) |
| `property.requests` | maker-checker requests (K4, K5, K10, K11, SC, P6, P13, P14); one open per file; decided once; 72 h |
| `property.assignments`, `reviews`, `review_documents`, `reopenings` | reviewers per group (legal, valuation, technical); reviews per discipline with the hashes relied on; a reopening makes earlier reviews of its discipline stale (shared sequence `property.seq`) |
| `property.title_links`, `encumbrances`, `encumbrance_resolutions` | chain of title; encumbrances discharged or condition precedent (OB-22) |
| `property.valuers`, `valuations` | approved panel (maker-checker), a natural-person valuer is a KYC subject; valuations in paisa with the report and independence declaration hashes |
| `property.ic_meetings`, `ic_votes` | committee meeting closed once with the minutes hash; votes with independence and conflicts |
| `property.structures`, `trustee_decisions` | REIT/SPV, Shariah, unit rights, planned units and the derived 10 % holding limit, trust deed; the trustee's accept/decline |
| `property.audit` | hash-chained (`pt-property-audit-v1`, UTC); `detail.ref` names the row each entry describes |

Advisory locks: 586586140 (audit), 586586141 (sponsor creation), 586586142 (submissions and the duplicate check).

### 0015 offering (OFR-1..OFR-9; spec S-02, task T-020)

| Table | Key columns and constraints |
|---|---|
| `offering.settings`, `transitions`, `request_rules` | configuration (LEGAL TO CONFIRM values; the only allowed transitions L1..L18 and V1..V22; which duties approve each request kind); no role writes them |
| `offering.duties` | duty per officer (offering, compliance, legal_head, trustee, bank_operator); requested and decided by two different administrators; a trustee holds no other duty |
| `offering.offerings` | uuid; property (one live offering per property, unique per token); terms (price paisa, min raise, target, hard cap, min/max units, open/close, grace, reservation minutes, completion days, categories, use of proceeds, document SHA-256s) immutable after submission; structure, register size and MaxBalance limit from S-01; `token`, `extended_close_at`, `withdrawal_until`, `funded_at`, `completion_deadline`, `completing_at`, `mint_started_at`, `completed_at`, `failed_at` set once |
| `offering.offering_events`, `subscription_events` | the state logs; trigger `apply_event` refuses anything outside `transitions` or not from the current state |
| `offering.subscriptions` | uuid; refId (unique, keccak of the id, checked by recon); units, amount = units × price; category; idempotency key unique per investor and offering; one open reservation per investor and offering; `wallet`, `intent_code` (FK `bank.payment_intents`), `expires_at`, `raast_ref` (FK `bank.credits`), `paid_journal`, `settled_journal`, `mint_tx`, `refund_journal` set once; internal `reason` and investor-facing `public_reason` |
| `offering.acceptances` | append-only acceptance of the exact document version (kind, language, SHA-256, keyed session and device hashes) |
| `offering.requests`, `request_votes` | maker-checker requests (L3, L7, L8, L10, L11, L12, L13, L14, L15, L16, IB, CMP, SD, V17, V20); one open per kind and subject; decided once; votes once per officer with the duty they filled |
| `offering.issuance_batches`, `issuance_items` | batch digest `sha256('pt-issuance-batch-v1' || [refId, wallet, units, subscription] sorted by refId)`, approved through request IB |
| `offering.conditions_precedent`, `completions`, `register_attestations` | L13 evidence hashes; CMP deed and completion batch; L14 register total and hash |
| `offering.mint_commands` | every `issuance.mint` outbox command per subscription and attempt (`mint:<refId>`, retries `mint:<refId>:retry:<n>`) |
| `offering.refunds` | one per subscription: cause, approval request, Raast reference, amount; journal set once when sent |
| `offering.payment_anomalies` | a matched credit for a subscription no longer waiting (reported by reconciliation) |
| `offering.audit` | hash-chained (`pt-offering-audit-v1`, UTC); `detail.ref` names the row each entry describes |
| `bank.intent_cancellations`, `bank.credit_refunds` | bank amendment (ADR 0009 B-8, B-9): cancelled payment codes; returns of matched subscription credits (`sub:<refId>:refunded`, original reference) |

`bank.book_credit` is replaced (cancelled codes go to suspense) and a trigger on `bank.credits` confirms the reservation of a matched subscription credit in the same transaction. Lock order: payment code 586586098 → ledger 586586002 → bank audit 586586095 → offering audit 586586150; per-investor lock 586586151; rows locked `FOR NO KEY UPDATE`.

### 0016 admin approvals (A-1..A-7; Step 6b, task T-004, ADR 0011 section 10)

Numbered 0016 because 0015 is the offering module (S-02) built in parallel; merge 0015 first (no-gap rule). Tests build databases from a renumbered copy (`contiguousMigrations()` in `backend/packages/db/test/helpers.ts`); the admin portal's own runner applies files in order without the gap check.

| Object | Purpose |
|---|---|
| `admin.role_permissions` (+9 rows) | `approvals.read` for auditors; `approvals.decide` (ops checker), `approvals.request` (ops maker), `property.read` (maker, checker, compliance, auditor), `property.decide` (checker, compliance); `admin.expected_role_matrix_digest()` fixed again |
| `admin.decision_context` | (txid, handle) while an admin function acts for an officer; triggers on `signer.approvals`, `recon.unfreeze_requests`, `bank.payout_batches` refuse an officer's handle without it (A-3) |
| `admin.signer_tickets` | one-time decision tickets (SHA-256 only, 2 minutes, bound to session, request, decision, reason, payload hash and call hash); used once, never deleted |
| `admin.issue_signer_ticket`, `signer.decide_officer` (+ internal `admin.redeem_signer_ticket`, `complete_signer_ticket`) | the two halves of a signing decision: the portal gets a ticket, the signing service redeems it and runs `signer.decide` under the officer's handle (A-5) |
| `admin.decide_unfreeze`, `request_unfreeze`, `decide_payout_batch`, `decide_property_request` | session + permission + step-up, then the backend function under the officer's handle; refusals returned as `{ok:false, error}` and audited (A-2, A-4) |
| `admin.approvals_inbox`, `signer_request`, `payout_batch`, `unfreeze_request`, `property_request` | reads for the portal (no personal data: subject id prefixes, IBAN last four, no sealed values) with the reasons a decision is unavailable |
| `admin.duty_roles`, `admin.officer_holds`, trigger `staff_duties_officer`, replaced `property.has_duty` | S-01 duties need a portal officer with a matching role and count only while that officer is active and holds it (A-7) |

Grants: `pt_admin_portal` gets EXECUTE on the five reads and five decision functions only; `pt_signer` gets EXECUTE on `signer.decide_officer`. No new table grants.

### 0017 notify (N-1..N-9; ADR 0013, task T-028)

Numbered 0017 because 0015 (S-02 offering) and 0016 (Step 6b) are on other branches; until they are merged the runner's no-gap rule refuses 0017 on a database built from this branch alone (the notify tests use a renumbered copy, `backend/packages/notify/test/helpers.ts`).

| Table | Key columns and constraints |
|---|---|
| `notify.event_kinds` | kind, category `security`/`transactional`, typed placeholders (`utc`, `paisa`, `last4`, `code`, `label`, `word` with choices); seeded, immutable |
| `notify.templates` | kind, channel `sms`/`email`/`push`, locale `en`/`ur`, version (insert-only, latest wins, English fallback), subject (e-mail only, no CR/LF), body (SMS ≤ 500 characters), body SHA-256; placeholders checked against the kind |
| `notify.recipients` | uuid; `subject_type` investor (KYC subject uuid) or officer (officer id); locale; only the locale may change |
| `notify.contacts` | recipient, channel `sms`/`email`, `lookup_hash` (HMAC-SHA256 under `NOTIFY_LOOKUP_KEY`), `sealed` (AES-256-GCM bound to recipient, channel, hash), `key_version`; one current per recipient and channel; superseded once, never edited or deleted |
| `notify.preferences` | per recipient and channel, transactional notices only; append-only (latest row wins, none = on) |
| `notify.notifications` | idempotency key (unique), kind, category, recipient, params (validated by `notify.params_problem`), content hash, status `queued`/`suppressed`/`undeliverable`; immutable |
| `notify.deliveries` | one per notification and contact; `uid` (provider idempotency key), contact and template bound at enqueue; status `pending → claimed → sending → sent`, exits `dead` → `pending` (operator retry) or `abandoned`; lease; attempts/max (8 security, 5 transactional); provider message id written once on `sent` |
| `notify.attempts` | one open attempt per delivery; recorded before the provider call; outcome `accepted`/`not_accepted`/`rejected`/`unknown`, provider message id, SHA-256 of the rendered message; finished once |
| `notify.rate_limits` | max deliveries per recipient, channel and rolling hour, per category |
| `notify.audit` | hash-chained (`pt-notify-audit-v1`, UTC) |

API: `notify.enqueue` (producers, in their transaction), `register_recipient`, `register_contact`, `set_preference`, `set_locale` (service), `claim`, `delivery_material`, `begin_attempt`, `record_sent`, `record_failure`, `extend_lease`, `open_attempt_started` (worker), `operator_decide`, `add_template`, `stats`, `verify_audit` (operator). NOTIFY channels: `notify` (new work, at commit), `notify_alert` (dead letter, undeliverable security notice). Advisory locks: 586586170 (audit), 586586171 (rate limit per recipient and channel), 586586172 (contact registration).

### 0018 web offering (WO-1..WO-6; spec S-02 investor UI, task T-044)

No tables. Thin `SECURITY DEFINER` functions so the website's role `pt_web` can serve the investor offering screens, and nothing else of `offering`, `kyc`, `bank`, `recon` or `property`:

| Function | Purpose |
|---|---|
| `offering.web_offerings(p_offering uuid DEFAULT NULL)` | offerings from `ready` on: public terms, aggregate units (paid, held, available, waitlisted), anchored document hashes (hex), use of proceeds, and coarse property facts (province, district, use, covered area). No parcel, deed, address, GPS, sponsor or investor data (WO-5) |
| `offering.web_subscriptions(p_subject uuid)` | one investor's subscriptions; payment code and trustee escrow account (`recon.bank_accounts` for `bank:trustee-escrow`) only while `payment_pending` (WO-6); refund status `requested`/`approved`/`sent`/`in_review`; `blocked`/`disputed` read `under_review` with no reason (WO-4, tipping-off) |
| `offering.web_subscription_events(p_subject uuid)` | state history (code, state, time); no actor or reason |
| `offering.web_accept_document(...)` | wraps `offering.accept_document` (OF-10) |
| `offering.web_reserve(offering, sub, refId, subject, units, idempotency, actor)` | KYC gate: refuses (42501) unless `kyc.subject_status(subject) = 'verified'` (WO-2); then `offering.reserve(..., 'retail', ...)` |
| `offering.web_cancel(sub, subject, actor)` | wraps `offering.cancel` (V11) |

Every write requires an actor `web:<website investor uuid>` (WO-3). `pt_web` gets `USAGE` on schema `offering` and `EXECUTE` on these six functions only; the helpers `offering.web_check_actor` and `offering.web_state` are not granted.

### 0019 compliance (C-1..C-8; Step 6c, task T-005, ADR 0011 section 11)

Numbered 0019 because 0018 is reserved for parallel work (no dependency on it); until 0018 is merged the backend runner refuses the gap and tests use `contiguousMigrations()`. Schema `compliance`; advisory locks 586586190 (audit) and 586586191 (freeze requests).

| Object | Purpose |
|---|---|
| `compliance.reason_codes` | (code, applies_to `freeze`/`unfreeze`/`str`, label); seeded, append-only; freeze requests and STR cases reference it with a composite key |
| `compliance.kyc_cases` | subject, kind `screening_match`/`sanctions_hit`/`manual`, check (unique), risk (only raised), flags (only added), summary, status `open`/`info_requested`/`pending_second`/`approved`/`rejected`/`superseded`, proposal + proposer, Y-4 clearance, decider; CHECKs: proposer ≠ decider, high risk and screening outcomes need a proposal, a list hit is never approved; trigger-enforced transitions; never deleted |
| `compliance.kyc_case_events` | every transition (action, from, to, actor, reason); append-only |
| trigger `checks_compliance_cases` on `kyc.checks` | a sanctions `review` (incl. `pep_match`) or `fail` opens a case; a newer screening supersedes the open one |
| `compliance.freeze_requests` | kind, subject, wallet, reason code, reason, links to KYC/STR cases, unfreeze → the freeze it lifts, `case_ref` (bytes32 caseId), 24 h expiry, decider ≠ proposer, outbox `command_key` when approved; decided once |
| `compliance.holds` | one active hold per wallet from an approved freeze; lifted once by an approved unfreeze |
| `kyc.underlying_status()` (new), `kyc.subject_status()` (replaced) | the 0009 derivation; with an active hold a verified or expired investor reads `suspended` |
| `kyc.request_clearance()`, `kyc.evaluate()` (replaced), `kyc.clearances` proposal CHECK | new proposal `accept_edd` (only for a `pep_match` check): a PEP accepted by two officers verifies with its own reason |
| `compliance.str_cases`, `str_events`, `str_notes`, `str_exports` | STR state machine `open`/`under_review`/`close_proposed`/`closed`/`filed`; closer ≠ proposer; filing needs an export and the FMU reference; notes, events and exports append-only |
| `compliance.rescreens` | queue for the KYC service (`queued → running → done/failed`, one live per subject, stale claims return after 10 min) |
| `compliance.audit` | hash-chained (`pt-compliance-audit-v1`, UTC); `compliance.verify_audit()` also finds rows without their audit entry or event |
| `compliance.free_text_ok()` | CHECK on every free text: no CNIC, IBAN or Pakistani mobile number |
| triggers `*_officer_binding` | officer handles in compliance rows, `kyc.clearances` and `kyc.decisions` only with the admin function on the stack |
| `admin.role_permissions` (+2) | `compliance.decide`, `compliance.export` for compliance officers; digest fixed again |
| `admin.compliance_dashboard`, `kyc_queue`, `kyc_case`, `screenings`, `freeze_requests`, `freeze_request`, `str_cases`, `str_case`, `str_export_data` | reads (masked CNIC `*****-****NNN-N`, no names, hashes or evidence) with per-action blockers and digests |
| `admin.open_kyc_case`, `kyc_case_act`, `request_rescreen`, `request_freeze`, `decide_freeze`, `open_str`, `add_str_note`, `str_act`, `record_str_export` | writes; step-up on every decision; refusals audited as `approval.refused` |
| `admin.audit_rows`, `verify_chains`, `record_export` (replaced) | new audit source `compliance` |

Grants: `pt_admin_portal` EXECUTE on the 18 admin functions; `pt_signer` EXECUTE on `compliance.unfreeze_allowed`; `pt_kyc_service` on `claim_rescreens` / `complete_rescreen`; `pt_kyc_officer`, `pt_admin_auditor` on `compliance.verify_audit`. No table grants.

### 0020 recovery (RV-1..RV-10; spec S-06 section 14, task T-026)

Schema `recovery` (role `pt_recovery_worker` runs `recovery.tick`):

| Table | Purpose / rules |
|---|---|
| `cases` | `wallet_recovery`, `succession`, `reversal`; `case_ref` = SHA-256 of `pt-case-v1:<uuid>` (caseId on chain); state machine in trigger `guard_case` (opened → approved → executed → closed; opened → rejected / cancelled → closed; reversal opened → closed); identity columns immutable; decisions written once; release proposer ≠ confirmer ≠ maker (CHECK); one live case per wallet / new wallet / journal (partial unique indexes) |
| `approvals` | one per (case, capacity) and per (case, officer); capacities `operations`, `compliance`, `legal`; digest bound; append-only |
| `documents` | metadata + SHA-256 only (death certificate, succession certificate, letters of administration, court order, family settlement, re-verification, other); free text refused with CNIC/IBAN/phone; append-only |
| `heirs` | KYC subject, bound wallet, share numerator/denominator; append-only |
| `proposals` | one RecoveryGuard request per case (recovery) or per heir with units (succession): outbox keys of propose/execute/cancel, on-chain request id and eta from the read model; enqueued → pending → executed / cancelled, enqueued → failed / cancelled |
| `wallet_history` | old → new wallet of an executed recovery (the only change `kyc.wallets` accepts, via `rebind_context` and trigger `kyc.guard_wallet`) |
| `reversal_reasons`, `reversible_kinds` | reference lists (append-only); reversible: `rent_received`, `cash_topup` |
| `audit` | hash-chained (`pt-recovery-audit-v1`, UTC); `verify_audit()` also finds rows written around the functions |

Functions: `open_case`, `open_reversal`, `set_new_wallet`, `add_document`, `add_heir`, `decide`, `cancel`, `release`, `tick`, `allocation` (floor + largest remainder with a family settlement), `shares_complete` (exact, lcm), `reversal_problem`, `command_allowed` and `pending_from` (signing service), views `recon_requests`, `recon_reversals` (reconciliation). Portal: `admin.recovery_cases|case|open|add_document|add_heir|set_wallet|act|sync`; `admin.audit_rows / verify_chains / record_export` know the source `recovery`. Notify kind `security.wallet_recovery_requested` (EN/UR SMS + e-mail). Admin role `legal_officer`, permissions `recovery.read|request|decide`. Changes `kyc.wallets` from strictly append-only to "append-only except the recovery rebinding" (0009 Y-5 amended).

### 0021 operations and tax (OT-1..OT-11; spec S-03, tasks T-023/T-024, ADR 0014)

Applies on top of 0020 (adds the `legal_officer` x `tax_officer` incompatibility and fixes the role-matrix digest again). Schemas `ops` and `tax`; advisory locks 586586210 (audit), 586586211 (rate versions), 586586212 (calculation per token/period), 586586213 (remittance per token/period), 586586214 (certificate).

| Object | Purpose |
|---|---|
| `ops.settings` | `allow_placeholder_rates` (false; local dev only), `filer_check_max_age_days` 30, `expense_ops_limit_paisa` (placeholder Rs 1,000,000, Q-5), `export_valid_hours` 24, `export_ticket_seconds` 120, `wht_due_days` 15 (placeholder); every change audited |
| `ops.collections` | rent from one recon bank line (used once): source `matched_credit` (bank service already booked it), `suspense_credit` (bank:suspense -> pool, OP-12) or `unbooked_line` (bank -> pool); period = month of the value date; maker-checker; journal `rent:collected:<token>:<period>-c<id>` (external_ref = bank reference) on approval |
| `ops.charges` | expense / fee (`property_manager`, `trustee`, `platform`) / reserve contribution / reserve release, payee, description, amount, evidence SHA-256; maker-checker; journals `expense:<token>:<id>:approved`, `fee:<token>:<period>:<type>`, `reserve:<token>:<period>`, `reserve:<token>:release:<id>` (external_ref = evidence hex); expense/fee above the limit refused (trustee, 6d) |
| `ops.period_totals()`, `ops.operating_statement()` | OP-30/OP-31 from approved records: net operating cash, distributable gross (never < 0) and shortfall |
| `ops.distributions` | one live calculation per (token, period), which locks the period; operating statement snapshot, record date/block, income type, sums (CHECK gross = WHT + net = distributable), flagged and placeholder line counts, statement, statement hash, Merkle root, tax schedule and its hash, maker/attacher/checker (all different), on-chain id and journals; states `calculated -> attached -> approved -> booked`, `returned` |
| `ops.distribution_lines` | wallet, subject (or none), units at the record block, gross (largest remainder), filer status with check id and ATL as-of date, flag, rate id and rate (ppm), WHT, net; CHECKs gross = net + WHT and WHT = floor((gross x ppm + 500,000) / 1,000,000); append-only |
| `ops.calculate_distribution()`, `attach_statement()`, `decide_distribution()`, `book_distribution()` | calculation from `chain.transfers` up to the record block; statement v2 and tax schedule v1 checked line by line; approval refuses placeholder rates; booking needs the finalized on-chain distribution with the same root, record block, statement hash and total = sum of net, and posts `rent:wht:<token>:<id>` and `rent:distribution:<token>:<id>` together |
| `tax.income_types`, `tax.rates` | versioned, dated rates per income type and status (`filer`, `non_filer`, `exempt`), rate in ppm, basis, placeholder flag; proposal -> approval by a different officer; effective today or later; seeded PLACEHOLDERS (LEGAL/TAX TO CONFIRM) for `reit_dividend` and `spv_dividend`; no seed for `rent` (slab-based) |
| `tax.rate_for()`, `tax.withholding()`, `tax.filer_status()` | rate in force at a record date; the rounding rule; OP-41 status (latest ATL result <= 30 days, else non-filer, flagged) |
| `tax.sealed_cnics`, `tax.filer_checks` | ADR 0014: AES-256-GCM ciphertext bound to subject + peppered CNIC hash (FK to `kyc.cnic_hashes`) + pepper version; ATL results (status, as-of, provider, evidence SHA-256); both append-only |
| `tax.remittances` | token, period, amount (<= withheld - remitted), CPR, bank reference and account; maker-checker; journal `tax:remit:<token>:<cpr>` (payable -> bank) |
| `tax.certificates`, `tax.certificate_data()`, `tax.issue_certificate()` | annual certificate data per investor and fiscal year (July-June, by closing year), content SHA-256, superseding chain |
| `tax.filing_exports`, `tax.export_tickets` | ADR 0014 X-4: requested -> approved (different officer) -> generated once (file SHA-256 and rows recorded before release); tickets single use, at most 10 minutes (setting 2) |
| `tax.reconcile(token)` | findings `tax.line_arithmetic`, `rent.wht_mismatch`, `tax.payable_mismatch` (per period and whole account), `tax.wht_unremitted` |
| `ops.audit`, `ops.verify_audit()` | hash-chained (`pt-ops-audit-v1`, UTC) for ops and tax; finds rows without their audit entry |
| `admin.roles`, `role_conflicts`, `role_permissions` | role `tax_officer`; permissions `operations.read/request/decide`, `tax.read/decide/export`; conflicts tax officer x admin, auditor, trustee, ops maker, compliance; digest fixed again |
| `admin.operations_periods`, `operations_statement`, `operations_charge`, `operations_distribution`, `tax_overview`, `tax_exports`, `tax_export` | reads (no CNIC or name; investors as 8-character subject references) with blockers and digests |
| `admin.propose_charge`, `decide_charge`, `decide_distribution`, `propose_tax_rate`, `decide_tax_rate`, `request_tax_export`, `decide_tax_export`, `issue_tax_export_ticket` | writes; step-up on every decision and on every tax action; refusals audited |

Grants: `pt_ops_operator` (operations CLI), `pt_ops_reader`, `pt_tax_service` (only role that reads sealed CNICs or redeems tickets), `pt_recon_writer/reader` EXECUTE `tax.reconcile`, `pt_admin_portal` EXECUTE on the 15 admin functions.
### 0022 web account and catalogue (WA-1..WA-5; task T-045)

Applies on top of 0021. No tables. Four thin `SECURITY DEFINER` read functions for the website's role `pt_web`:

| Function | Purpose |
|---|---|
| `bank.web_payees(p_subject uuid)` | one investor's payout accounts: id, last four digits, bank code, registered, `active_from` (end of the 72 h cooling-off), superseded. Never the IBAN hash or the sealed IBAN (WA-2). Registration stays with the bank service (`bank.register_payee` needs keys the website does not hold) |
| `property.web_catalog()` | for offerings visible under WO-5 (`ready` and later): building name, province, district, use, covered area, built, occupancy, lease count, declared monthly rent, structure (kind, Shariah, planned units, holding limit), trustee acceptance time, sponsor KYB approved (boolean), valuations (count, lowest, highest, latest date). No floor/unit/plot/deed/address/GPS, sponsor identity, valuer or officer (WA-3) |
| `property.web_documents(p_offering uuid)` | current (not superseded) documents of an allow-listed set of types (`property.web_public_doc_type`: title deed, land record, building plan, completion certificate, insurance, valuation, legal opinion, technical report, trust deed, SPV documents, Shariah certificate, audited financials) as SHA-256 hex, upload time and "verified at source"; never KYB documents, leases, rent rolls, tax receipts, utility bills, photos, court orders or minutes (WA-4) |
| `recon.web_status()` | the latest finished run (passed/failed), its time, pinned block, blocking and warning counts, and `recon.payout_gate().allowed`; never findings (WA-5) |

`pt_web` gets `USAGE` on schemas `bank`, `property`, `recon` and `EXECUTE` on these four functions only (tested: `db/test/web-account.test.ts` enumerates every function in the three schemas).
### 0023 trustee (T-1..T-7; Step 6d, task T-006, ADR 0011 section 12)

Applies on top of 0022 (after S-06's 0020 and S-03's 0021; the role-matrix digest is fixed again after all of them). Schema `trustee`; advisory locks 586586230 (audit), 586586231 (one review per distribution), 586586232 (register balance per token and wallet).

| Object | Purpose |
|---|---|
| `signer.trustee_cosign_kinds` | kinds the specs assign to the trustee (`issuance.mint`); append-only |
| `signer.requests.trustee_approvals_needed` (new column) | 1 when the kind is listed and the request needs platform approvals; set by trigger `requests_trustee_requirement` on insert, immutable (`requests_trustee_guard`), which also refuses `pending_approval -> approved` without both capacities |
| `signer.approvals.capacity` (new column) | `platform` / `trustee`, set by trigger `approvals_capacity` from the approver's role (active `trustee_officer` officer = trustee) |
| `signer.decide()` (replaced), `signer.approval_counts()` | counts platform and trustee approvals separately; refuses a platform approval once the platform part is complete and a trustee approval where none is needed |
| `admin.signer_tickets.capacity` (new column), `admin.guard_signer_ticket()`, `redeem_signer_ticket()`, `complete_signer_ticket()`, `signer_blockers()`, `signer_request()` (replaced) | trustee tickets need `trustee.decide` at issue and redemption; the outcome also goes to `trustee.audit`; detail reads show both capacities |
| `offering.has_duty()` (replaced), trigger `duties_officer_check`, trigger `request_votes_officer_binding` | for a portal officer the S-02 `trustee` duty is the active `trustee_officer` role and no other duty is allowed (OF-SOD-4); votes under an officer handle only through the portal |
| `trustee.distribution_reviews` | one decision per (registry, distribution): approve (with the recomputed root, equal to the published root) or reject, reason, digest of what was shown, window end, decider; append-only |
| `trustee.distribution_blocked()`, triggers `payout_batches_trustee_review` (bank) and `journal_trustee_review` (ledger, only keys `rent:distribution:%` and S-03's `rent:wht:%`) | a rejected distribution gets no payout batch and no booking |
| `trustee.register_entries` | the trustee's own unit register per token and wallet: + units on V18 (`active`), - units on `redeemed` (trigger `subscription_events_trustee_register`), and approved adjustments; append-only, balance never below zero; backfilled from existing active subscriptions |
| `trustee.adjustments` | two-officer register corrections with evidence SHA-256, 72 h, one open per wallet; decided once |
| `trustee.register_lines()` | register next to `chain.holdings` for one token (full outer join on the wallet) |
| `trustee.audit` | hash-chained (`pt-trustee-audit-v1`, UTC); `trustee.verify_audit()` also finds reviews, register entries, adjustments and trustee co-signatures without their audit entry |
| `trustee.recovery_cases_json()` | 0020's wallet-recovery and succession cases for the trustee, read-only (no subject identifiers beyond a short reference) |
| `trustee.charge_decisions`, `trustee.charge_problem()`, trigger `charges_trustee`, `ops.decide_charge()` (replaced) | OP-21: a charge above `expense_ops_limit_paisa` is approved only after the trustee approved it; a trustee rejection leaves only "reject" |
| `trustee.calculation_checks`, `trustee.calculation_problem()`, trigger `distributions_trustee_precheck` | D4: `attached -> approved` of an `ops.distributions` row needs the trustee's pre-check with a recomputed root equal to the attached root (and the same statement hash) |
| `admin.operations_charge`, `admin.operations_distribution` (replaced) | 0021 reads, now with the trustee's decision and blocker |
| `admin.trustee_charge`, `trustee_calculation`, `decide_trustee_charge`, `precheck_distribution` | trustee reads (`trustee.read`) and decisions (`trustee.decide`, step-up, digest) |
| triggers `*_officer_binding` | officer handles in trustee rows only with the admin function on the stack |
| `admin.role_permissions` (+4) | `trustee.decide`, `trustee.export`, `audit.export` for trustee officers; `trustee.export` for auditors; digest fixed again |
| `admin.trustee_dashboard`, `trustee_register`, `register_adjustment`, `trustee_cosign_queue`, `trustee_signer_request`, `trustee_offering_request`, `trustee_distributions`, `trustee_distribution`, `trustee_recon`, `trustee_recon_run`, `trustee_recoveries` | reads (`trustee.read`): chain numbers pinned to the indexer cursor (one snapshot), per-action blockers and digests |
| `admin.issue_trustee_ticket`, `decide_offering_request`, `review_distribution`, `propose_register_adjustment`, `decide_register_adjustment`, `record_register_export` | writes (`trustee.decide`, export `trustee.export`); step-up on every decision; refusals audited as `approval.refused` |
| `admin.audit_rows`, `verify_chains`, `record_export` (replaced) | new audit source `trustee` (0020's `recovery` kept) |

Grants: `pt_admin_portal` EXECUTE on the 21 new admin functions; `pt_admin_auditor` EXECUTE on `trustee.verify_audit`. No role can read or write a `trustee` table directly.
### 0024 investor passkeys (IP-1..IP-9; task T-030, ADR 0010 section 8)

Follows 0020-0023 (0022's `pt_web` grants are untouched). Schema `webauth`; advisory lock 586586240 (audit).

| Object | Purpose |
|---|---|
| `webauth.settings` | one row: `require_passkey` (default off while the demo server is plain HTTP by IP). Changed by the database administrator only; every change audited (`settings.changed`) |
| `webauth.step_up_actions` | action → `min_amount_paisa` for the passkey step-up: `offering.reserve` 10,000,000 (PKR 100,000), `offering.cancel` 0, `bank.payout_account` 0 (checked by the website through `web_require_recent_passkey` before it asks the bank service). An action not listed always needs a step-up (deny by default). Changes audited |
| `webauth.passkeys` | credential ID (PK, base64url), random `ref` (what the website shows and revokes by), investor, label (`webauth.name_ok`: 1-40 chars, no markup, no 6-digit run), public key, counter (forward only), transports, AAGUID, format, `singleDevice`/`multiDevice`, backed up, created, last used, revoked once (`investor` or `clone_suspected`); never deleted |
| `webauth.sessions` | SHA-256 of the cookie token, investor, method `passkey`/`persona`/`signup`, credential (passkey method), created, last seen (forward), `expires_at = created + 12 h`, `passkey_at` + credential of the last passkey assertion (forward), ended once (`logout`, `idle`, `absolute`, `superseded`, `passkey_revoked`); never deleted |
| `webauth.challenges` | ceremony id hash, purpose `register`/`login`/`step_up`, challenge, session (register and step-up), created, expires (≤ 5 min), used, completed (once, ≤ 5 min after use); housekeeping removes rows a day after expiry |
| `webauth.audit` | hash-chained (`pt-webauth-audit-v1`, UTC); `webauth.verify_audit()` also finds passkeys and sessions without their audit entry |
| `webauth.web_session`, `web_start_session`, `web_end_session` | session check per request (ends it at 30 min idle / 12 h; touches at most every 15 s), demo starts (`persona` for persona investors, `signup` within 30 min of the investor's creation), logout |
| `webauth.web_create_challenge`, `web_consume_challenge`, `web_auth_failed` | ceremonies: registration needs re-authentication (IP-5), step-up needs a passkey, 5 open per session, 10,000 open sign-ins; lockout after 10 failures in 15 min (IP-7) |
| `webauth.web_credential`, `web_session_credentials`, `web_registration_user` | public key for verification; allow/exclude lists; user handle and name |
| `webauth.web_add_passkey`, `web_login`, `web_step_up` | record a verified result only after a consumed challenge of the same ceremony (once); user verification required; counter forward or both 0, else the passkey is revoked as `clone_suspected`, its sessions end and `pg_notify('webauth_alert')` fires |
| `webauth.web_passkeys`, `web_revoke_passkey` | list (ref, label, synced, created, last used, used by this session; no credential data); revoke after a passkey within 5 minutes, ending the other sessions that used it |
| `webauth.web_step_up_status`, `web_require_recent_passkey` | `requireRecentPasskey`: `ok`, `waived`, `step_up`, `enrol`, `session` (status read-only; require audited) |
| `webauth.web_reserve`, `web_cancel` | the session-bound wrappers of `offering.web_reserve` / `web_cancel` (0018): investor and KYC subject from the session, actor `web:<id>`, audited gate first; return `{"error": "step_up"|"enrol"|"session"}` when refused |

Grants: `pt_web` gets `USAGE` on `webauth` and `EXECUTE` on the 18 `webauth.web_*` functions only (no table, no internal function), and **loses** `EXECUTE` on `offering.web_reserve` and `offering.web_cancel`.

### 0025 web anchor status (WN-1..WN-4; task T-047, ADR 0008 and 0010)

Applies on top of 0024 (0026 is reserved for a parallel branch). No tables. Two thin `SECURITY DEFINER` read functions for the website's role `pt_web`, scoped to the "current" anchor target = the anchor chain and contract of the newest `anchor.anchors` row (WN-3), so an earlier stand-in deployment never mixes in:

| Function | Purpose |
|---|---|
| `anchor.web_status()` | one row (none before the first anchor): anchor chain ID, contract, and of the latest confirmed anchor the private chain ID and block, commitment, transaction hash, anchor-chain block and confirmation time; number of confirmed anchors; age in seconds; `open_state` `pending` (an anchor is recorded or sent) / `failed` (the newest anchor failed and none is open) / `none`, and `open_since` |
| `anchor.web_recent(p_limit integer)` | the newest non-failed anchors with their commitment components (private chain ID, block, block hash, ledger journal id and head hash), commitment, status (`recorded`/`sent`/`confirmed`), transaction hash, anchor-chain block, confirmation time; at most 20 rows, NULL or below 1 means 12 (WN-4) |

Never returned (WN-2): the signed raw transaction, nonce, sender, creator, history or failure reason (a failure is the coarse `failed` state only). `pt_web` gets `USAGE` on schema `anchor` and `EXECUTE` on these two functions only; tables stay unreadable (tested: `db/test/web-anchor.test.ts` enumerates every function in schema `anchor` and checks 42501 on both tables and the writer API).

### 0026 portal votes (V-1..V-6; task T-046, ADR 0011 section 13, specs S-01 §16, S-02 §18)

Applies on top of 0025 (reserved for parallel work; the runner refuses the gap until it is merged). No new table; the votes land in 0014/0015's tables through their own functions.

| Object | Purpose |
|---|---|
| `admin.role_permissions` (+9) | `committee.vote` (ops_maker, ops_checker, compliance_officer), `offering.read` (those three and auditor), `offering.decide` (ops_checker, compliance_officer); digest fixed again |
| triggers `ic_votes_officer_binding`, `ic_meetings_officer_binding` (status change), `trustee_decisions_officer_binding` | an officer's handle as committee member, closing chair or P8 trustee only with the admin function on the stack (`admin.guard_officer_name`, 0016 A-3) |
| `admin.committee_digest(meeting, votes)` | SHA-256 (`pt-committee-v1`) of the meeting, property state, latest review per discipline, valuations, current documents and (for the close) the votes |
| `admin.committees`, `admin.committee` | reads (`property.read`): open meetings, files ready for a meeting, latest outcomes; one meeting with reviews, qualifications, valuation status, documents, votes with their reasons, outcome, digests, vote and close blockers |
| `admin.open_committee`, `committee_vote`, `close_committee` | `committee.vote` + step-up; `property.open_ic` / `cast_vote` (vote reason as property audit `ic.vote_reason`) / `close_ic` (minutes SHA-256, note as `ic.close_note`) under the officer's handle, bound to the digest |
| `admin.property_trustee_digest(property)` | SHA-256 (`pt-property-trustee-v1`) of the property, latest structure, approving meeting and current documents |
| `admin.trustee_properties`, `admin.trustee_property` | reads (`trustee.read`): Legal Approved properties with their latest structure; one property with structure, committee, valuations, documents, decisions, digest, blockers |
| `admin.decide_property_trustee` | `trustee.decide` + step-up; refuses a second decision on a structure (V-4); `property.trustee_decide` under the officer's handle; `trustee.audit` `property.accepted` / `property.declined` |
| `admin.offering_missing_duties(request)` | the platform duties (not `trustee`) an open request still lacks |
| `admin.offering_votes`, `admin.offering_vote_request` | reads (`offering.read`): open requests lacking a platform vote, offerings pending approval whose L3 lapsed, latest platform votes; one request with the offering terms, property, votes, missing duties, digest (`admin.offering_request_digest`, 0023), vote and return blockers |
| `admin.vote_offering_request`, `admin.return_offering` | `offering.decide` + step-up + digest; `offering.decide` / `offering.return_offering` (L2) under the officer's handle |
| `admin.vote_refused` | audited refusal (`approval.refused`) with the backend's SQLSTATE in `state` |
| helpers `admin.reason_ok`, `officer_has`, `property_json`, `property_documents_json`, `committee_*_blockers`, `trustee_property_*blockers`, `offering_*_blockers`, `offering_terms_json`, `committee_row` | internal (no grant) |

Grants: `pt_admin_portal` EXECUTE on the 12 portal functions above (6 reads, 6 decisions). No role reads or writes the property or offering vote tables directly.

### 0027 exit (EX-DB-1..EX-DB-8; spec S-05 sections 14-16, task T-025, ADR 0005/0007/0011 amendments)

Schema `exit`. Additive changes elsewhere: income type `exit_distribution` with PLACEHOLDER rates (`tax.rates`), register entry source `redemption` (`trustee.register_entries`), co-sign kind `issuance.burn` (`signer.trustee_cosign_kinds`), step-up actions `exit.redemption_request` / `exit.redemption_withdraw` (`webauth.step_up_actions`), permissions `exit.read|request|decide` (role matrix digest fixed again), audit source `exit` in `admin.audit_rows|verify_chains|record_export`.

| Object | Purpose |
|---|---|
| `exit.settings` | vote quorum/majority/notice, record notice days, default burn rule, redeeming SLA, window cap/discount/length (LEGAL TO CONFIRM; changes audited) |
| `exit.cases`, `exit.case_events`, `exit.transitions` | one live case per token; state only through the event log (X1-X18); proposal immutable; decision facts set once |
| `exit.decision_kinds`, `exit.decisions`, `exit.votes`, `exit.conflicts` | X1-X12, X18, HR proposed by a maker, approved by one officer per capacity (operations checker, compliance, legal, trustee); proposer, opener, repeat voter and conflicted officer refused; digest bound |
| `exit.proceeds` | deposit/proceeds from trustee-escrow statement credits or suspense credits; maker-checker; `exit:<token>:deposit` / `exit:<token>:proceeds:<n>` into `exit:pool:<token>` |
| `exit.waterfalls`, `exit.waterfall_lines` | versions (draft, submitted, checked, approved, returned); maker / operations checker / trustee officer; all line journals on the trustee's approval (`exit:<token>:waterfall:<line>`, `exit:<token>:reserve-release:<line>`, `exit:<token>:rent-transfer:<line>`) |
| `exit.payments` | escrow debit lines paying approved outflow lines; maker-checker; `exit:<token>:waterfall:<line>:paid` |
| `exit.finals`, `exit.final_lines`, `exit.final_prechecks`, `exit.final_links` | final distribution (S-03 arithmetic from the exit pool, every holder a line), statement/schedule checked line by line, trustee pre-check (root), checker approval, on-chain link (tick), booking (`rent:wht`, `rent:distribution` from `exit:pool`) |
| `exit.redemptions`, `exit.redemption_lines`, `exit.releases`, `exit.burns`, `exit.burns_seen` | redemption batch (holders and balances at the record block, refIds from the service), maker / checker / trustee; HR releases; burn commands enqueued once (`burn:<refId>`); burns seen in the read model |
| `exit.windows`, `exit.requests` | phase-0 redemption windows (NAV price, cap) and investor requests (one live per window, free balance, cap, withdraw, maker-checker outcome) |
| `exit.burn_allowed(jsonb)` | the signing service's gate for `issuance.burn` (granted to `pt_signer` only) |
| `exit.tick(actor)` | X13-X15, burns enqueued and seen, X17; idempotent |
| views `exit.recon_lines`, `recon_cases`, `recon_finals` | reconciliation (granted to `pt_recon_writer`, `pt_recon_reader`) |
| `exit.audit`, `exit.verify_audit()` | hash chain (`pt-exit-audit-v1`, UTC) and rows written around the API |
| `admin.exit_overview`, `exit_case`, `exit_window`, `exit_request`, `exit_decide`, `exit_sync` | PT Control (`pt_admin_portal`) |
| `webauth.web_exit_overview`, `web_redemption_request`, `web_redemption_withdraw` | website (`pt_web`), session-bound, step-up gate |

Roles: `pt_exit_operator` (exit service / operator command line: maker steps, statement, redemption items, checker steps as S-03, tick, windows), `pt_exit_reader`.

### 0028 transfers (XF-1..XF-10; spec S-04 section 16, ADR 0005/0007/0009/0010/0011 amendments)

Applies on top of 0027 (S-05 exit): uses `exit.exit_underway()` and `exit.requests` in its checks and keeps 0027's register source `redemption`. Schema `transfer` (role `pt_transfer_worker` runs `transfer.tick`):

| Table | Rules |
|---|---|
| `cases` | one case per transfer; `case_ref` = SHA-256 of `pt-transfer-v1:<uuid>` (caseId in the signing payloads); origin `desk` or `investor`; consideration `sale` (price, total = units × price) or `gift` / `family` / `court_order` (no price, a reason); agreement SHA-256; state machine in trigger `guard_case` (requested → checks → rejected / awaiting_cash / proposed; awaiting_cash → proposed / cancelled / refunding; proposed → executed / cancelling / failed; cancelling / failed → executed / refunding / cancelled; refunding → cancelled; executed → settled / disputed; settled → disputed); parties, units, price, agreement immutable; decision facts written once; command attempts only forward |
| `events` | append-only state history of every case |
| `decisions` | one per capacity (`compliance`, `trustee`) and per officer per case, with the reviewed digest |
| `checks` | recorded runs of `transfer.check_results(case, stage)` (stages complete, approve, payment, execute) when the result changes |
| `receive_codes` | the buyer's single-use code `TR-XXXX-XXXX` (7 days), used once by a website request |
| `reference_prices` | valuation per unit with the evidence SHA-256 (operations checker); the latest one, else the offering price, is the price-band reference |
| `conflicts`, `party_links` | officers' declared conflicts with an investor (TR-SOD-2); declared links between investors (surveillance) |
| `alerts` | surveillance alerts (price outside the band, round trip, frequent, linked parties), each with its 6c STR case |
| `blocks` | per-token blocks (S-05 exit hook, incidents), closed once |
| `cash_ops` | seller settlement (gross, fee, withholding at a `tax.rates` row, net, payee) or buyer refund (credit reference): prepared by an operations maker, decided once by an operations checker (≠ preparer, opener, completer); journals and the instruction SHA-256 on approval |
| `settings` | lock-up, price band, payment hours, screening age, fee, SLAs, surveillance limits, allowed countries, `unapproved_from_block`; changed by the administrator only, audited |
| `audit` | hash-chained (`pt-transfer-audit-v1`, UTC); `verify_audit()` also finds rows written around the functions |

Functions: `open_desk`, `web_new_code`, `web_request`, `web_accept`, `web_withdraw`, `withdraw`, `complete`, `decide`, `cancel`, `dispute`, `tick` / `tick_case`, `prepare_cash`, `decide_cash`, `set_reference_price`, `declare_conflict`, `link_parties`, `open_block` / `close_block`, `check_results`, `command_allowed` (signing service), `reconcile(token)` and view `recon_requests` (reconciliation), `web_list`. Portal: `admin.transfer_cases|case|open|act|cash|sync|set_price|declare_conflict|link_parties|audit`; website: `webauth.web_transfers|web_transfer_code|web_transfer_request|web_transfer_accept|web_transfer_withdraw` and step-up actions `transfer.request|accept|withdraw`. Amendments of other schemas (additive): bank purpose `transfer` on `bank.payment_intents` (named constraints), register source `transfer` on `trustee.register_entries`, income type `unit_disposal` with PLACEHOLDER rates in `tax.rates` (audited in `ops.audit`), notify kinds `security.transfer_requested`, `transfer.status_changed`, `transfer.payment_due` (EN/UR SMS + e-mail), permissions `transfer.read|request|decide|cash|price` (role matrix digest fixed again).

### 0029 service roles (task T-012, ADR 0016)

No tables. Fifteen NOLOGIN groups `pt_svc_<service>` (section 5), each a member (`WITH INHERIT TRUE, SET FALSE`) of existing domain roles, plus narrow direct grants: `SELECT outbox.commands` to `pt_svc_outbox` (the worker decides from the database after an executor error); column-level `SELECT` on `webdemo.subscriptions (investor_id, ref_id, tokens)`, `webdemo.investors (id, wallet_address)` and ten columns of `bank.payout_batches` to `pt_svc_recon` (what the run reads; no names, CNIC hashes, keys or payees); `kyc.enqueue_offboarding` alone to `pt_svc_offboarding`; `exit.tick` alone to `pt_svc_exit`. No existing role is widened. Logins are created by `npm run db:service-roles`, not by the migration.

## 4. Append-only and hash-chain rules (summary)

| Area | Append-only | Hash chain / verify |
|---|---|---|
| Ledger | journal, postings; balances forward-only | `ledger.verify_chain()`, `ledger.verify_balances()` |
| Outbox | command identity fields; `command_events` | none |
| Signer | policies, approvals, audit | `signer.verify_audit()` |
| Chain | events, blocks, transfers, issuances, freeze actions, halts | parent-hash linkage |
| Recon | runs, findings, statements, gate events | `recon.verify_audit()` |
| Anchor | history; anchor inputs immutable | public anchor + `anchor:verify` |
| KYC / bank | all records | `kyc.verify_audit()`, `bank.verify_audit()` |
| Notify (0017) | event kinds, templates, preferences, notifications, audit; recipients (locale only), contacts (superseded once), deliveries (state edges only), attempts (finished once) | `notify.verify_audit()` (also re-checks sent deliveries) |
| Property (0014) | all records; requests, duties, meetings, persons and valuers decided or ended once | `property.verify_audit()` (also replays states and re-checks document and review hashes) |
| Offering (0015) | all records; requests, duties, refunds decided or sent once; subscription facts set once | `offering.verify_audit()` (replays states, re-checks batch digests, finds rows without audit, incl. bank cancellations and refunds) |

| Admin approvals (0016) | signer tickets used once, never deleted; decisions, refusals and views in `admin.audit` | `admin.verify_audit()` (role matrix digest updated in 0016) |
| Compliance (0019) | reason codes, case events, STR events/notes/exports, audit; cases, requests, holds, rescreens change only along their state machines | `compliance.verify_audit()` (rows without audit entry, status vs last event, holds vs decisions) |
| Investor passkeys (0024) | audit; passkeys (counter forward, revoked once), sessions (last use and passkey time forward, ended once), settings and step-up actions (no delete, every change audited) | `webauth.verify_audit()` (passkeys and sessions without their audit entry) |
| Exit (0027) | audit, transitions, decision kinds, case events, votes, conflicts, final lines, pre-checks, links, redemption lines, releases, burns, burns seen; cases, decisions, proceeds, waterfalls, lines, payments, finals, redemptions, windows, requests change only along their state machines; no TRUNCATE | `exit.verify_audit()` (rows without their audit entry) |

A superuser can still disable triggers; the public anchor exists to detect that (ADR 0008).

## 5. Roles

All NOLOGIN, created idempotently:

| Migration | Roles |
|---|---|
| 0002 | `pt_ledger_writer`, `pt_ledger_reader` |
| 0003 | `pt_outbox_writer`, `pt_outbox_worker`, `pt_outbox_operator`, `pt_outbox_reader` |
| 0004 | `pt_signer`, `pt_signer_operator`, `pt_signer_auditor` |
| 0005 | `pt_chain_writer`, `pt_chain_reader` |
| 0006 | `pt_recon_writer`, `pt_recon_operator`, `pt_recon_reader` |
| 0007 | `pt_anchor_writer`, `pt_anchor_reader` |
| 0009 | `pt_kyc_service`, `pt_kyc_officer`, `pt_kyc_reader`, `pt_bank_service`, `pt_bank_operator`, `pt_bank_reader` |
| 0014 | `pt_property_writer`, `pt_property_reviewer`, `pt_property_admin`, `pt_property_reader` |
| 0015 | `pt_offering_service`, `pt_offering_officer`, `pt_offering_admin`, `pt_offering_reader` (and `offering.mint_allowed` for `pt_signer`) |

| 0017 | `pt_notify_producer` (enqueue only), `pt_notify_service`, `pt_notify_worker`, `pt_notify_operator`, `pt_notify_reader` |
| 0018 | no new role: `pt_web` (0012) may execute the six `offering.web_*` functions |
| 0021 | `pt_ops_operator`, `pt_ops_reader`, `pt_tax_service` |
| 0022 | no new role: `pt_web` may execute `bank.web_payees`, `property.web_catalog`, `property.web_documents`, `recon.web_status` |
| 0024 | no new role: `pt_web` may execute the `webauth.web_*` functions; `offering.web_reserve` / `web_cancel` revoked from it |
| 0025 | no new role: `pt_web` may execute `anchor.web_status()` and `anchor.web_recent(integer)` (nothing else in schema `anchor`) |
| 0027 | `pt_exit_operator`, `pt_exit_reader`; `pt_signer` may execute `exit.burn_allowed`; `pt_web` may execute `webauth.web_exit_overview`, `web_redemption_request`, `web_redemption_withdraw` |
| 0028 | `pt_transfer_worker` (`transfer.tick`); `pt_signer` may execute `transfer.command_allowed`; `pt_web` the five `webauth.web_transfer*` functions (no grant on schema `transfer`) |
| 0029 | one group per backend service process, composed from the roles above (T-012, ADR 0016): `pt_svc_indexer`, `pt_svc_signer`, `pt_svc_outbox`, `pt_svc_kyc`, `pt_svc_offboarding`, `pt_svc_bank`, `pt_svc_anchor`, `pt_svc_recon`, `pt_svc_recovery`, `pt_svc_tax`, `pt_svc_notify`, `pt_svc_exit`, `pt_svc_transfer`, `pt_svc_audit`, `pt_svc_console` |

Logins (`LOGIN`, member of exactly one group, `SET FALSE`): the website `pt_web_app` (`npm run db:web-role`, group `pt_web`), the portal (`admin/scripts/setup-server.mjs`, group `pt_admin_portal`) and one `pt_<service>_app` per backend service (`npm run db:service-roles`, group `pt_svc_<service>`; credentials in the git-ignored `backend/.env.local`). Services refuse to run as the admin except on a loopback database with `PT_DB_ADMIN_FALLBACK=1` (development). Migrations, setup and break-glass operator commands use the admin. The reviewed privilege inventory of every service group is `backend/packages/db/test/service-roles/<service>.txt`.

## 6. Ledger account conventions

From `backend/packages/recon/src/conventions.ts` and the `0009` checks: `web:sub:<uuid>:paid|settled|refunded`, `sub:<refId>:...`, `rent:collected:<token>:<id>`, `rent:pool:<token>`, `rent:distribution:<token>:<id>` (external_ref = statement hash), `rent:payable:<subjectId>`, `rent:payout:<token>:<id>` and `...:followup:<batch>`, `investor:<subjectId>:subscriptions`, `bank:trustee-escrow`, `bank:suspense`, `property:<token>:capital` (equity; credited by `sub:<refId>:settled` at completion, 0015). S-03 (0021): `vendor:payable:<payee>`, `fees:payable:<payee>`, `reserve:<token>`, `tax:wht-payable:<token>`, `rent:payable:wallet:<wallet>` (holder without a KYC subject); S-05 (0027): `exit:pool:<token>`, `reserve:<token>:closure`, `debt:payable:<payee>`, `deposit:payable:<payee>`, `tax:payable:<token>`, journals `exit:<token>:deposit`, `exit:<token>:proceeds:<n>`, `exit:<token>:waterfall:<line>[:paid[:<payment>]]`, `exit:<token>:reserve-release:<line>`, `exit:<token>:rent-transfer:<line>` (the final distribution keeps `rent:wht` / `rent:distribution` / `rent:payout`); journals `rent:collected:<token>:<period>-c<id>`, `expense:<token>:<id>:approved`, `fee:<token>:<period>:<type>`, `reserve:<token>:<period>`, `reserve:<token>:release:<id>`, `rent:wht:<token>:<id>`, `tax:remit:<token>:<cpr>`. S-04 (0028): account `transfer:<caseUuid>:escrow` (liability, one per priced case), `fees:payable:platform`, `tax:cgt-payable:<token>`; journals `xfer:<caseUuid>:paid` (by `bank.book_credit`), `:fee`, `:tax`, `:settled`, `:refunded`. The web prototype uses accounts `web:bank:subscriptions`, `web:bank:client-money`, `web:investor:<id>:subscription`, `web:investor:<id>:cash`, `web:property:<symbol lower-case>:capital`, `web:order:<id>:escrow`, and journal keys such as `web:sub:<id>:paid|settled|refunded`, `web:topup:<id>`, `web:trade:<id>:settle|release`, `web:order:<id>:reserve|release` (grep of `web/src/lib/server/*.ts`).

## 7. `webdemo` (runtime, prototype only)

| Table | Notes |
|---|---|
| `investors` | `persona` ALICE/BOB; `cnic_last4`, `cnic_hmac` unique, `phone_last3`; `wallet_address` unique, `wallet_key_enc`; `kyc_status` pending/verified/rejected |
| `subscriptions` | `request_id` unique; `ref_id` unique; `status` paid/minting/done/refunded/review; `mint_tx`, `mint_nonce`, `mint_from`; `bank_ref` `RAAST-DEMO-*` |
| `topups` | demo cash, `request_id` unique |
| `orders` | buy/sell, price, `filled <= tokens`, open/filled/cancelled |
| `trades` | buyer <> seller; settling/settled/failed/review; `transfer_tx`, `transfer_nonce` |

No migration, no checksum, no roles, no audit chain. It duplicates concepts that `kyc` and `bank` now cover (task T-009).
