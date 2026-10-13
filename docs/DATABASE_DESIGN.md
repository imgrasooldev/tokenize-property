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
| Property (0014) | all records; requests, duties, meetings, persons and valuers decided or ended once | `property.verify_audit()` (also replays states and re-checks document and review hashes) |
| Offering (0015) | all records; requests, duties, refunds decided or sent once; subscription facts set once | `offering.verify_audit()` (replays states, re-checks batch digests, finds rows without audit, incl. bank cancellations and refunds) |

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

The website does not use these roles; it connects as the admin user (task T-012).

## 6. Ledger account conventions

From `backend/packages/recon/src/conventions.ts` and the `0009` checks: `web:sub:<uuid>:paid|settled|refunded`, `sub:<refId>:...`, `rent:collected:<token>:<id>`, `rent:pool:<token>`, `rent:distribution:<token>:<id>` (external_ref = statement hash), `rent:payable:<subjectId>`, `rent:payout:<token>:<id>` and `...:followup:<batch>`, `investor:<subjectId>:subscriptions`, `bank:trustee-escrow`, `bank:suspense`, `property:<token>:capital` (equity; credited by `sub:<refId>:settled` at completion, 0015). The web prototype uses accounts `web:bank:subscriptions`, `web:bank:client-money`, `web:investor:<id>:subscription`, `web:investor:<id>:cash`, `web:property:<symbol lower-case>:capital`, `web:order:<id>:escrow`, and journal keys such as `web:sub:<id>:paid|settled|refunded`, `web:topup:<id>`, `web:trade:<id>:settle|release`, `web:order:<id>:reserve|release` (grep of `web/src/lib/server/*.ts`).

## 7. `webdemo` (runtime, prototype only)

| Table | Notes |
|---|---|
| `investors` | `persona` ALICE/BOB; `cnic_last4`, `cnic_hmac` unique, `phone_last3`; `wallet_address` unique, `wallet_key_enc`; `kyc_status` pending/verified/rejected |
| `subscriptions` | `request_id` unique; `ref_id` unique; `status` paid/minting/done/refunded/review; `mint_tx`, `mint_nonce`, `mint_from`; `bank_ref` `RAAST-DEMO-*` |
| `topups` | demo cash, `request_id` unique |
| `orders` | buy/sell, price, `filled <= tokens`, open/filled/cancelled |
| `trades` | buyer <> seller; settling/settled/failed/review; `transfer_tx`, `transfer_nonce` |

No migration, no checksum, no roles, no audit chain. It duplicates concepts that `kyc` and `bank` now cover (task T-009).
