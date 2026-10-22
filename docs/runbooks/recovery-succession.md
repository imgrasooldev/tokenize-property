# Runbook: wallet recovery, succession and reversals (spec S-06)

Portal: PT Control `/recovery`. Rules are enforced by the database (migration 0020); this runbook is the order of work. Never move tokens or rebind a wallet by hand.

## Services that must run

- Indexer (`npm run indexer`): the read model decides "frozen on chain", balances and request ids.
- Outbox worker (`npm run outbox`) and signing service (`npm run signer`) with the six `recovery.*` policies active.
- `npm run recovery:tick -- --loop` (or the portal button "Refresh from chain"): links proposals to on-chain requests, queues `execute` after the 48-hour delay, queues `cancel` for cancelled cases, rebinds the KYC wallet after an executed recovery.
- Notifications worker (`npm run notify:run`) for the investor alert.

## Lost or compromised wallet (custodial)

1. A lost phone or login is an account recovery, not this case (S-06 RF-1).
2. Operations maker: open a "Lost / compromised wallet" case for the investor's KYC subject. The wallet is frozen (protective) and the contacts of record are told; the 48-hour objection window starts.
3. Re-verify the person (branch or video call): KYC service `POST /v1/reverify` with CNIC, name and a fresh liveness session (client `recovery`). The case shows "NADRA + liveness passed".
4. Operations maker: "Create the new wallet" (security key). Possible only before any decision.
5. After the window, with the old wallet frozen on chain: an operations checker and a compliance officer approve (different people, not the maker). The add-key and propose commands go to the outbox; the add-key is signed by the OLD custodial key (if that key is gone, stop: owner question OQ-1).
6. 48 hours on chain later the tick queues `execute`. After execution the KYC binding moves to the new wallet and the case is `executed`.
7. Two compliance officers release: the new wallet is unfrozen (the token carried the freeze over).

## Succession

1. Operations maker: open a "Succession" case for the deceased's subject (protective freeze at once).
2. Record documents (type, reference, issuer, SHA-256 only): death certificate and one of succession certificate / letters of administration / court order; a family settlement if all adult heirs accept the largest-remainder split.
3. Add heirs: each must be KYC-verified with a registered wallet; shares as fractions summing to exactly 1. Check the allocation preview.
4. A legal officer and a compliance officer approve. One forced transfer per heir is proposed; each executes after 48 hours. Without a settlement the remainder units stay frozen for a cash-out (not built: RC-14).

## Objection or error during the delay

Any deciding officer cancels the case. Pending on-chain requests get `cancel` commands (Trustee key); requests not yet proposed are never proposed. When nothing is open any more, two compliance officers release the freeze. Reopening means a new case.

## Reversal of a platform error

Only a journal of a reversible kind (`rent_received`, `cash_topup`) booked wrongly by the platform. Operations maker opens with the journal number, reason and the SHA-256 of the incident evidence; an operations checker approves; the correcting journal (exact contra) is posted at once. If the money already moved on, the ledger refuses: fix the downstream booking first. Bank recalls and court-ordered reversals are not this flow.

## Reconciliation

- `recovery.unmatched` (blocking): an on-chain recovery request that no case proposed. Treat as a possible key compromise: follow `key-compromise.md`; cancel the request (Admin or Trustee Safe) during its 48-hour delay.
- `recovery.reversal_unmatched` (blocking): a correcting journal without its case: a write around the API; investigate with the audit chains (`npm run recovery:audit`).
- `recovery.unmatched_cancelled` (warning): a cancelled request without a case (the local demo has one from `chain/flow.py`).
