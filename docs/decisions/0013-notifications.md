# ADR 0013: Notifications (SMS, e-mail, push later)

- Status: Proposed (task T-028, awaiting lead review)
- Date: 2026-10-13
- Builds on: ADR 0004 (outbox: lease, record before send, LISTEN/NOTIFY), ADR 0009 (sealed personal data, payout accounts with 72-hour cooling-off), ADR 0012 (PostgreSQL queues, `node:http` services, no Redis)
- Addresses: threat M-1 (payout redirected: "an alert on every change"), API-2 (new device), the "Notifications" sections of specs S-01..S-06, product map ("alerts on every sensitive account change")

## Context

Several controls depend on the investor hearing about a change in time: the 72-hour cooling-off on a new payout account (M-1) only helps if the real owner is told; a new-device sign-in or a changed phone number is the first sign of an account takeover. Until now the database raised `NOTIFY bank_alert` / `kyc_alert`, but nothing delivered a message. Messages must not become a new leak: an SMS gateway or mail provider must never receive more personal data than the message needs, and the database must not hold readable phone numbers or e-mail addresses.

No SMS or e-mail provider is contracted yet (task T-031).

## Decision

A schema `notify` (migration `0017_notify.sql`) and a package `@pt/notify` with **mock providers only**.

| Rule | What it guarantees |
|---|---|
| N-1 | Recipients are subject ids only (investor = KYC subject uuid, officer = officer id). Phone numbers and e-mail addresses are an HMAC-SHA256 under `NOTIFY_LOOKUP_KEY` (for lookups) and an AES-256-GCM copy under `NOTIFY_DATA_KEY`, bound to recipient, channel and hash (the KYC sealing construction). Keys live outside the database. Only the worker role ever receives the sealed value; it opens it in memory for the provider call and checks it against the hash. Provider error texts are redacted before they are stored or logged |
| N-2 | Every event kind has typed placeholders (UTC time, paisa, last four digits, short code, short label, a word from a fixed list). `notify.enqueue` refuses unknown keys, wrong types, codes or labels with 7+ consecutive digits or an `@`. Templates may use only their kind's placeholders. No links in any message (phishing defence) |
| N-3 | Transactional notices follow per-channel preferences (default on). **Security notices cannot be switched off** (there is no preference for them). A security notice with no contact on file is recorded as `undeliverable` and raises `NOTIFY notify_alert`: never silently dropped |
| N-4 | `notify.enqueue` is called **inside the producer's transaction** (rollback removes it; `NOTIFY notify` fires at commit), idempotent per key. The contacts and template version are bound at enqueue, so a later contact change cannot redirect an alert already raised. Replacing a contact sends `security.contact_changed` to the **replaced** contact too |
| N-5 | **Record before send.** A delivery is leased (`FOR UPDATE SKIP LOCKED`); the attempt is recorded (`claimed → sending`) before the provider is called, and only with enough lease left for the provider call (send timeout + margin). A `sending` delivery whose lease expired is re-leased for **resolution only**: the provider is asked whether it accepted the delivery's idempotency key; it is never sent again blindly |
| N-6 | Retries: `30 s × 2^(attempt−1)`, at most 1 h; 8 attempts for security, 5 for transactional. A permanent refusal, running out of attempts, or an outcome that stays unknown past `reviewAfterMs` (30 min) moves the delivery to `dead` (dead letter, `NOTIFY notify_alert`). Only an operator with a reason (≥ 10 characters) can retry or abandon it |
| N-7 | Rate limits per recipient and channel per rolling hour (`notify.rate_limits`; security 20 SMS / 30 e-mail, transactional 5 / 10). Over the limit a delivery is deferred, never dropped, and uses no attempt |
| N-8 | Append-only records; hash-chained audit (`pt-notify-audit-v1`, UTC); `notify.verify_audit()` also re-checks sent deliveries against their audit entry and finds rows written around the API |
| N-9 | Roles: `pt_notify_producer` (enqueue only: the narrow grant other services get), `pt_notify_service` (recipients, contacts, preferences), `pt_notify_worker` (delivery API), `pt_notify_operator` (dead letters, templates, audit), `pt_notify_reader` (status without hashes or ciphertext) |

### Exactly-once, as far as a provider allows

An SMS gateway is not transactional, so "exactly once" means: **at most one provider acceptance per delivery, and never lost** (it ends `sent` or in the dead letters, visible to operations). The worker decides after a failure from what is provable:

| Failure | Meaning | Worker does |
|---|---|---|
| `ProviderRejected` | provider refused for good | dead letter |
| `ProviderUnavailable` | request provably never reached the provider | retry with backoff |
| anything else (timeout, reset, 5xx after sending) | unknown | nothing now; after the lease, `lookup(idempotencyKey)`: accepted → `sent`; not found → retry; unknown → wait, then dead letter |

Adapter contract (T-031): pass the delivery's uid as the provider's idempotency key where supported, honour the abort signal, throw `ProviderUnavailable` only when nothing reached the provider, and make `lookup` authoritative once the call has ended. Where a provider has neither idempotency keys nor a lookup, its adapter must answer `unknown` (the delivery goes to the dead letters rather than risk a duplicate).

A property test checks this against a reference model with random refusals, outages, failures before and **after** acceptance (a crash between send and record), failing lookups and up to three racing workers, using a mock that does not deduplicate (worst case). Two deliberate mutations (retrying an unknown outcome at once; resolving without asking the provider) make it fail.

### Event catalogue (security notices now)

| Kind | Category | Placeholders | Producer (wiring is a follow-up per module) |
|---|---|---|---|
| `security.new_device_sign_in` | security | device (label), at | web sign-in (T-030) |
| `security.contact_changed` | security | channel, at | `notify.register_contact` itself (built) |
| `security.payout_account_added` | security | last4, active_from | `bank.register_payee` (first account) |
| `security.payout_account_changed` | security | last4, previous_last4, active_from | `bank.register_payee` (replacement) |
| `security.payout_account_active` | security | last4 | cooling-off end: a periodic sweep over `bank.payees` |
| `security.kyc_status_changed` | security | status: verified / expired / action_required / closed | `kyc.evaluate`, `kyc.revoke` (generic words only: no tipping-off) |
| `security.account_frozen` / `_unfrozen` | security | at | freeze/unfreeze confirmed (offboarding, compliance cases) |
| `security.large_transaction_pending` | security | amount (paisa), reference | signer maker-checker request waiting for approval |
| `offering.reservation_expiring` | transactional | offering, amount, expires_at | S-02 offering (2 h before expiry) |
| `rent.paid` | transactional | token, amount, period | bank payout line paid |

Templates exist for SMS and e-mail in English and Urdu (version 1, in the migration). Urdu text is right-to-left; numbers and Latin codes inside it are wrapped in Unicode isolates; e-mail HTML carries `lang="ur" dir="rtl"`. SMS must fit three segments (GSM-7 153/160, UCS-2 67/70); a test renders every template with the longest allowed values.

### Wiring plan (not in this change)

Producers call `notify.enqueue` **in the same transaction** as their business change: preferably inside their own SQL function (a later migration owned by that module redefines it with `CREATE OR REPLACE` and adds the call), otherwise from TypeScript on the same client. Each wiring migration grants `pt_notify_producer` to that module's service role. A `NOTIFY bank_alert` listener is not a substitute: it is not transactional and loses alerts while the listener is down. No trigger on another schema's table is added here. The per-module list is in [TASKS.md](../TASKS.md) (T-028).

## Consequences

- Real providers, push, and running `notify:run` as a service with alerting on `notify_alert` are separate tasks (T-031, T-040, T-034/T-035).
- Contact ownership (one-time code to the new number or address) must be proved by the caller before `register_contact`; the website and app flows for contacts and preferences do not exist yet.
- Officer notifications (S-01 §9, S-02/S-03 operations and trustee notices) need their own kinds and templates in a later migration.
- Keys: rotating `NOTIFY_DATA_KEY` needs a re-seal job (`key_version` is stored per contact); not built.
