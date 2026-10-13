# Flow Diagrams

- Audited commit: `main` @ `41241b3` (2026-10-13). One diagram per flow. Each flow names the code that implements it; all are **Verified** against that code unless marked.
- Components: [ARCHITECTURE.md](ARCHITECTURE.md). Tables and rule IDs (L-, O-, S-, C-, R-, A-, Y-, B-, H-, I-): [DATABASE_DESIGN.md](DATABASE_DESIGN.md).

## 1. Investor onboarding and KYC

### 1a. Web prototype (what the website does today)

Code: `web/src/app/actions/auth.ts` `signUp`, `web/src/lib/server/onboarding.ts`.

```mermaid
flowchart TD
  A["Sign-up form: name, CNIC, phone, liveness tick, consent"] --> B{"zod valid?"}
  B -- no --> B1["Field errors returned"]
  B -- yes --> C{"CNIC ends in 0?<br/>inline mock NADRA"}
  C -- yes --> C1["error: nadra"]
  C -- no --> D{"cnic_hmac already in webdemo.investors?"}
  D -- yes --> D1["error: duplicate"]
  D -- no --> E["New custodial wallet, key AES-GCM encrypted,<br/>INSERT investor kyc_status=pending"]
  E -- unique violation 23505 --> D1
  E --> F["onboardOnChain via demo signer:<br/>ONCHAINID, KYC + AML claims, RegistrarGuard.register"]
  F -- fails --> F1["DELETE pending row, error: chain<br/>person may retry"]
  F -- ok --> G["kyc_status=verified, start session, redirect /account"]
```

### 1b. Backend KYC service (not yet used by the website)

Code: `backend/packages/kyc/src/service.ts` `KycService.onboard`, migration `0009_kyc_bank.sql`.

```mermaid
flowchart TD
  A["onboard: CNIC, name, liveness session, optional wallet"] --> B{"input valid?"}
  B -- no --> B1["KycError INVALID_INPUT"]
  B -- yes --> C{"subject with any pepper version of this CNIC?"}
  C -- yes, not retryable or other name --> C1["KycError DUPLICATE_CNIC"]
  C -- no --> D["kyc.register_subject: hashes, sealed name, last 4"]
  C -- retryable pending/rejected --> E
  D --> E["NADRA check"]
  E -- pass/review --> F["Liveness check"]
  F -- pass/review --> G["Sanctions screening"]
  E -- fail/error --> H
  F -- fail/error --> H
  G --> H["kyc.evaluate: status derived in DB"]
  H -- verified and wallet given --> I["kyc.bind_wallet"]
  H --> J["Result: verified / pending / review / rejected"]
  G -. possible match .-> K["Clearance: two different officers decide"]
```

Provider errors are recorded as `error` and never pass (fail-closed).

## 2. Sign-in and session (web)

Code: `web/src/app/actions/auth.ts`, `web/src/lib/server/session.ts`, `web/src/lib/server/rate-limit.ts`.

```mermaid
sequenceDiagram
  participant U as Browser
  participant A as loginAsPersona
  participant S as session.ts
  U->>A: POST persona=ALICE|BOB (Next.js origin check)
  A->>A: rate limit "login" by client key
  alt over limit
    A-->>U: redirect /login?e=rate
  else
    A->>S: startSession(investorId)
    S-->>U: Set-Cookie pt_session=id.expiry.hmac (HttpOnly, SameSite=Strict, 8 h)
    A-->>U: redirect /account
  end
  U->>S: later request
  S->>S: verify HMAC and expiry
  S-->>U: forged/expired -> signed out, private pages redirect to /login
```

No passwords; passkeys are planned (task T-030).

## 3. Invest, payment, ledger, mint

### 3a. Current path on `main` (web demo signer)

Code: `web/src/lib/server/invest.ts`, `web/src/lib/server/demo-signer.ts`.

```mermaid
sequenceDiagram
  participant U as Investor
  participant W as invest action
  participant DB as PostgreSQL (webdemo + ledger)
  participant DS as demo-signer
  participant CH as Besu
  U->>W: symbol, tokens, requestId, bankConfirm
  W->>W: pre-checks: KYC verified, isVerified on chain, not paused, min 10, max holding, trustee cap
  W->>DB: one tx: subscription row (paid) + journal subscription_paid (mock Raast ref)
  Note over W,DB: same requestId returns the first subscription (unique request_id, idempotency keys)
  W->>DB: claim paid -> minting
  W->>DS: IssuanceGuard.mint(wallet, tokens, refId)
  DS->>CH: simulate
  DS->>DB: advisory lock per signer, nonce, sign, record hash + nonce
  DS->>CH: broadcast
  alt mined success
    W->>DB: status done + journal subscription_settled
  else refused before broadcast or reverted
    W->>DB: status refunded + journal subscription_refunded
  else unknown (timeout, RPC error)
    W->>DB: status review
    Note over W,CH: reconcile settles review rows only on a Minted event for this refId, wallet and amount
  end
```

### 3b. Target path (Step 5h, in progress on a branch)

Code on `main`: `backend/packages/outbox/src/index.ts`, `backend/packages/signer/src/executor.ts`, `service.ts`. The web wiring is not on `main` (Incomplete).

```mermaid
sequenceDiagram
  participant BS as Business service
  participant DB as PostgreSQL
  participant OW as OutboxWorker
  participant SG as Signer (HMAC API)
  participant CH as Besu
  BS->>DB: BEGIN, post_journal, outbox.enqueue(issuance.mint, key mint:refId), COMMIT
  OW->>DB: claim (lease)
  OW->>SG: POST /v1/sign {commandRef, kind, payload}
  alt denied
    SG-->>OW: denied -> RefusedError -> command failed, nothing sent
  else needs approval
    SG-->>OW: pending_approval -> DeferredError -> outbox.defer (no attempt used)
    Note over SG: two operators other than the requester approve (signer:decide)
  else signed
    SG-->>OW: raw tx, hash, nonce
    OW->>DB: record_submission (only the lease owner)
    alt record refused (lease lost)
      OW->>SG: POST /v1/release (nonce reused, nothing sent)
    else recorded
      OW->>CH: sendRawTransaction
      OW->>SG: POST /v1/broadcast
      OW->>CH: wait receipt -> confirmed / reverted
    end
  end
  Note over OW,CH: after any error: decide from DB state, then chain (success, reverted, dropped, pending, unknown)
```

## 4. Market delivery versus payment (demo only)

Code: `web/src/lib/server/market.ts`.

```mermaid
flowchart TD
  A["Place order: price within +-10% of NAV, min 10, holding limit, no self-cross"] --> B{"side"}
  B -- buy --> C["Move full cost cash -> web:order:id:escrow"]
  B -- sell --> D["Only free on-chain tokens not already offered"]
  C --> E["Matcher: pg_try_advisory_lock, price-time, maker price"]
  D --> E
  E --> F["Trade + fills recorded, status settling"]
  F --> G["Seller custodial wallet transfer on chain"]
  G -- success --> H["Escrow -> seller cash, trade settled"]
  G -- refused or reverted --> I["Trade failed, both orders cancelled, escrow returned"]
  G -- unknown --> J["review, resolved later from the receipt"]
  H --> K["Unused escrow returns when the order ends"]
```

## 5. Rent distribution, Merkle verify, payout batches, held payouts

Code: `chain/rent.py`, `contracts/src/registries/DistributionRegistry.sol`, `web/src/lib/server/rent.ts`, `backend/packages/bank/src/service.ts`, migrations `0009`, `0010`, `0011`.

```mermaid
flowchart TD
  A["chain/rent.py: balances at a past block, paisa split, Merkle tree"] --> B["DistributionRegistry.publish root, total, statementHash"]
  B --> C{"Rejected within the 48 h challenge window?"}
  C -- yes --> C1["rejected"]
  C -- no --> D["finalize: anyone, after the window"]
  B --> V["Investor: Verify my share<br/>statement hash = on-chain hash, proof accepted, 1 paisa more rejected"]
  D --> E["bank.create_payout_batch: maker"]
  E --> F{"each line: verified investor with active payee?"}
  F -- no --> F1["line HELD: stays owed in rent:payable"]
  F -- yes --> F2["line paid"]
  E --> G["decide: checker, different operator, recon gate"]
  G --> H["submit: recon gate again, deterministic bank file, SHA-256 recorded before send"]
  H --> I["Same tx: ledger rent:payout journal + outbox rent.record_payout"]
  I --> J["Signer checks file hash = bank.distribution_file_hash, recordPayout on chain"]
  F1 --> K["Follow-up batch later: held lines only, each once, same maker-checker and gate"]
```

Gap: publish/finalize are done only by the dev script `chain/rent.py`; no backend command kind exists (task T-022). No producer books `rent:distribution:*` journals yet, so reconciliation reports `rent.missing_ledger` on the local chain.

## 6. Reconciliation, payout freeze and unfreeze

Code: `backend/packages/recon/src/run.ts`, `0006_recon.sql`, `backend/packages/signer/src/service.ts` `payoutGateDenial`.

```mermaid
flowchart TD
  A["npm run recon"] --> B["REPEATABLE READ snapshot, pin read-model block P"]
  B --> C["balanceOf/totalSupply at P, optional indexer verify"]
  C --> D["Pure checks: issuance, supply, holdings, cash, rent, integrity"]
  D --> E["complete_run: findings + result in one tx"]
  E -- any blocking finding --> F["Payouts FROZEN in the same tx"]
  E -- passed --> G["payouts_allowed = not frozen AND latest run passed AND < 26 h"]
  F --> H["Maker: recon:unfreeze --request with reason"]
  H --> I{"Checker: different operator, after a later passed run, within 24 h, same freeze?"}
  I -- yes --> J["Unfrozen"]
  I -- no --> K["Refused / expired"]
  G --> L["Signer and bank ask the gate for payout.*, rent.*, distribution.* kinds and batches"]
```

## 7. Public anchoring

Code: `backend/packages/anchor/src/anchorer.ts`, `0007_anchor.sql`, `contracts/src/anchor/StateAnchor.sol`.

```mermaid
sequenceDiagram
  participant J as Anchor job
  participant DB as anchor schema
  participant B as Besu
  participant L as Anchor chain (Anvil 586650)
  J->>DB: open anchor? finish it first (re-broadcast the SAME raw tx)
  J->>B: finalized block number + hash
  J->>DB: ledger head (journal id, hash)
  J->>J: commitment = keccak(domain, besuChainId, block, blockHash, journalId, headHash)
  J->>DB: record (status recorded) with raw signed tx
  J->>L: broadcast StateAnchor.anchor
  J->>DB: mark_sent, then confirm after receipt
  Note over J: contract and DB disagree -> AnchorAlarm (exit 3), never delete records
  Note over J,L: anchor:verify recomputes the ledger chain independently and checks every anchor
```

## 8. Offboarding and freeze

Code: `0011_integration.sql` `kyc.enqueue_offboarding`, `backend/packages/kyc/src/offboarding.ts`, `backend/packages/signer/src/policy.ts`.

```mermaid
flowchart TD
  A["KYC status changes: review, rejected, revoked, expired"] --> B["OffboardingWorker: kyc_alert notification or poll"]
  B --> C["kyc.enqueue_offboarding: one compliance.freeze per subject, decision, status"]
  C -- key exists --> C1["skip: never doubled"]
  C --> D["Outbox -> signer policy compliance.freeze"]
  D -- owner still KYC-verified --> D1["denied"]
  D -- daily count limit --> D1
  D --> E["FreezeGuard.freezeAddress with caseId, Ops Safe key"]
  E --> F["Unfreeze: manual, two officers (Step 6, Missing)"]
```

Per finding F-01/F-02 the full order is freeze, then move or redeem tokens, then delete identity via timelock; only the freeze is automated.

## 9. Deploy pipeline

Code: `.github/workflows/ci.yml`, `deploy-demo.yml`, `deploy/demo-server/ci-entry.sh`, `update.sh`.

```mermaid
flowchart LR
  P["push to main"] --> CI["CI: gitleaks, forge fmt/build/test/coverage, slither, web typecheck/lint/test/build, backend typecheck/lint/migrate/test, ABI drift"]
  CI -- failure --> X["no deploy"]
  CI -- success --> D["Deploy demo: needs DEMO_HOST variable"]
  D --> S["ssh forced-command key -> ci-entry.sh -> update.sh SHA on main"]
  S --> M["backend npm ci + migrate"]
  M --> W["stop pt-web, web npm ci + next build"]
  W -- build fails --> R["EXIT trap restarts pt-web, exit 5"]
  W --> T["start pt-web, restart pt-console"]
  T --> Q["smoke test GET /login = 200"]
```

The chain is not touched by updates. Playwright e2e does not run in CI (task T-011).
