# S-07: Public verification page

- Status: Draft for owner review (functional specification; no code yet)
- Date: 2026-10-13
- Product map: #4 Public verification page (Pilot)
- Builds on: contract-spec §6 (DistributionRegistry `verify`, DocumentRegistry), §7 and §7.1 (StateAnchor, anchor commitment v1), [ADR 0006](../decisions/0006-indexer.md) (read model), [ADR 0008](../decisions/0008-public-anchor.md) (anchor verify), web W3 rent self-verify, threats SC-9, CH-1, D-1, M-7

## 1. Purpose and scope

Let anyone check, without an account, what the platform claims about each property token: supply against the trustee register, document hashes, public-chain anchors, and (with their own data) a distribution entitlement. The page must be honest about what it proves and what still depends on trusting the platform, and must reveal no personal data.

## 2. Actors

Public visitor (no login); investor (brings their own proof); trustee (publishes register attestations); operations (no special powers on this page). The page is read-only: no write path exists.

## 3. Sections and rules

### 3.1 Supply vs trustee register

- **PV-1** Per token: `totalSupply`, `trusteeCap`, paused flag and the latest pause reason (e.g. `transfer-closed` vs an incident, S-04), number of holders, read at the read model's current block, with the block number and time.
- **PV-2** The trustee's **register attestation**: units outstanding, as-of date, attested by the trustee, document hash anchored in DocumentRegistry (`Other`, typed "register attestation"). Shown next to `totalSupply` at the block nearest the as-of time. Green only if equal; any difference is shown plainly and is a blocking reconciliation finding (`supply.register_mismatch`, S-02).
- **PV-3** No per-holder list or balance lookup by name; holder count only (SC-9, privacy). An investor sees their own balance in the portal.

### 3.2 Document hash verification

- **PV-10** Lists the token's DocumentRegistry records: type, added at, SHA-256, superseded by. Titles of documents come from the off-chain catalogue; the `uri` (`pt-doc://<id>`) is shown, the document itself is not.
- **PV-11** "Check a file": the visitor picks a file; the browser computes SHA-256 **locally** (Web Crypto); the file is never uploaded. The page shows whether the hash matches a current record, a superseded one, or none.
- **PV-12** Public documents (offering document, redacted summaries, audit reports) are downloadable and their hashes match records; documents with personal data (title deeds, leases) are never published; only their hashes are.

### 3.3 Anchor verification

- **PV-20** Lists recent anchors: public-chain transaction (link to the public explorer once the L2 is chosen), `besuBlock`, the commitment, and its components (domain, `besuChainId`, `besuBlock`, `besuBlockHash`, `ledgerJournalId`, `ledgerHeadHash`) from schema `anchor`.
- **PV-21** The browser recomputes `keccak256(abi.encode(...))` from the components and compares it with the value read from the public chain; the result is shown per anchor.
- **PV-22** Honesty statement on the page: the public anchor proves the platform committed to these values at that time and cannot later change them unnoticed; checking that the private chain and the ledger still match the committed hashes needs read access to the private chain or the ledger (validators, trustee, auditors) and is done by `anchor:verify`. The latest `anchor:verify` result and time are shown.
- **PV-23** Anchor freshness: the age of the latest anchor; warning if older than 2 hours.

### 3.4 Distribution entitlement (Merkle proof)

- **PV-30** Per distribution: id, status (Published, Rejected, Finalized, Paid), record block, `totalPaisa`, statement hash, published/finalized times, payout batch hash.
- **PV-31** Verify: the investor pastes or uploads their entitlement (wallet, net paisa, proof) from their portal statement. The browser computes the leaf `keccak256(bytes.concat(keccak256(abi.encode(wallet, amountPaisa))))` and the root with sorted-pair hashing and compares it with the published root; the server additionally calls `DistributionRegistry.verify` and shows both results. 1 paisa more must fail.
- **PV-32** An investor holding their full statement file can check its keccak256 against the on-chain `statementHash` locally.
- **PV-33** Nothing the visitor enters is stored or logged beyond rate-limit counters; no wallet search history.

## 4. Data and access

- Reads come from the indexer read model and the anchor schema through a read-only role (`pt_chain_reader` and an equivalent anchor reader); the private chain RPC is never exposed to browsers (MEMORY: chain RPC never public). On-chain view calls (PV-31) are made server-side at a pinned block.
- The public-chain values (PV-21) are read from a public RPC of the chosen L2, so this part does not depend on the platform's servers.
- No cookies, no analytics, CSP as the website (`web/`), rate limits per IP, cacheable responses (no chain in the read path, ADR 0001).

## 5. State, ledger, on-chain actions

The page has no state machine, no ledger journals and no on-chain writes. Reconciliation checks it relies on: `supply.register_mismatch` (S-02), `documents.*` (S-01), `rent.*` (S-03), anchor verify (ADR 0008). The page shows the latest reconciliation result as passed/failed with time (no finding details, which may contain investor data).

## 6. Exceptions

Read model halted (ADR 0006) → page shows "verification paused: indexer halted" and the time of the last good block; never stale data as current. Public L2 unreachable → anchor section shows "cannot reach public chain", local recomputation still available. Distribution rejected → shown as rejected with the reason.

## 7. Disclosures (on the page)

What each check proves and does not prove; that tokens mirror the trustee register and do not transfer title; how to obtain your proof; that documents with personal data are not published.

## 8. Regulatory assumptions (LEGAL TO CONFIRM)

1. Whether publishing holder counts, per-distribution totals and register attestations is allowed or required.
2. Whether publishing hashes of documents containing personal data is acceptable under Pakistan's data-protection rules (we assume yes: a SHA-256 of a file reveals nothing).

## 9. Acceptance criteria

1. A file is never uploaded for hash checking; network inspection shows no request containing the file.
2. Supply vs register shows a mismatch whenever they differ, at the stated block.
3. Every anchor's commitment is recomputed in the browser and matches the public chain value for honest data; a tampered component shows a mismatch.
4. A valid proof verifies, a proof with 1 paisa more fails, both locally and via `verify`.
5. No personal data appears in any response (automated PII scan like the KYC tests).
6. Page loads within the website's budgets (cached reads).

## 10. Test plan

- **Unit:** leaf/root computation against `chain/rent.py` fixtures; commitment recomputation against `@pt/anchor` fixtures; SHA-256 of files in chunks.
- **Integration:** read model + anchor schema on the test database; halted indexer path; mismatched register attestation.
- **E2E (Playwright, Edge):** check a file (match, superseded, none); verify an entitlement (valid, +1 paisa); anchor list with recomputation; no network upload of the file.

## 11. Open questions

- Q-1 Which public L2 (pending, ADR 0008) and its explorer links.
- Q-2 Frequency and format of the trustee's register attestation (daily proposed, signed by the trustee, hash anchored).
- Q-3 Should the page show holder counts and the reconciliation status publicly (recommended: yes, without details)?
