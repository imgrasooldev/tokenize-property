# Runbook: KYC or sanctions hit and offboarding

Identity rules are in the database (ADR 0009, Y-1..Y-6). A sanctions **hit** is final (Y-3); a
**possible match** is settled only by two different officers (Y-4); re-screening that removes a
verification alerts. Offboarding must follow the order fixed by findings F-01 and F-02 (contract
spec 4.2): **freeze → move or redeem the tokens → only then delete the identity**. Severity: SEV2
(SEV1 if a listed person moved value). Compliance officer leads; engineering supports.

## Trigger

- KYC service marks a sanctions hit or possible match (onboarding or re-screening).
- An updated sanctions/PEP list, a regulator or FMU request, a court order, fraud evidence.
- NADRA/liveness evidence later found false; an investor asks to close their account.

## Immediate actions

1. Compliance officer owns the case; open a case id (used as `caseId` on chain, stored only in events).
2. **Do not tell the investor about a suspicion report** (tipping-off is prohibited under the AML
   Act 2010; LEGAL TO CONFIRM wording and deadlines).
3. Freeze the wallet(s) at once through `FreezeGuard.freezeAddress(wallet, caseId)` (Ops Safe).
   Automated path: revoking the verification queues the freeze through the outbox and the signer
   (`compliance.freeze` kind):
   ```bash
   cd ~/property-token/backend
   npm run kyc:status -- <subjectId>     # status, checks, decisions (no personal data printed)
   npm run kyc:offboard                  # worker: queues a freeze for every wallet whose owner lost verification
   ```
4. Payouts to that subject are held automatically (not verified → held, H-1); do not pay manually.

## In the compliance portal (Step 6c, preferred)

Open `http://localhost:3300/compliance` (SSH tunnel). A possible match or PEP match already has a
case under **KYC reviews**; a list hit has a `sanctions_hit` case (final, close it as rejected).

- **Possible match / PEP:** officer A proposes approve or reject with a reason and the security
  key; officer B (different person) confirms or declines. For a PEP, approve means "accepted after
  enhanced due diligence" (keep the EDD file outside the portal).
- **Freeze now:** **Freezes** → propose (wallet, reason code, reason); a second officer approves.
  The investor reads `suspended` at once and the freeze command goes through the outbox to the
  signing service; check the command status on the request page. Unfreeze is the same two-officer
  path and needs the investor's own KYC status to be verified.
- **Suspicion:** **STR cases** → open, add notes, export for the FMU (the ZIP is recorded before it
  is handed out), file by hand in goAML, then record the FMU reference. Closing without a report
  needs a second officer.
- **Re-screen:** **Sanctions & PEP** → re-screen; the KYC service runs it (`npm run kyc:rescreen`
  must be running).

The SQL calls below remain the break-glass path for non-officer operator names only; officer
handles are refused outside the portal.

## Diagnosis and decisions

| Situation | Decision path |
|---|---|
| Possible match | Officer A requests a clearance (`kyc.request_clearance(check, officer, proposal, reason)`), officer B decides (`kyc.decide_clearance(request, officer, 'approve'|'reject', reason)`); B must differ from A (Y-4) |
| Confirmed hit | Final (Y-3). Freeze stays. Compliance files the suspicious transaction report with FMU (goAML) within the legal deadline (LEGAL TO CONFIRM) and informs SECP/trustee as required |
| Verification revoked for other reasons (fraud, expired, failed re-check) | Officer revokes: `kyc.revoke(subject, officer, reason)` (reason 10–300 chars); offboarding worker freezes |
| Investor voluntary exit | Not a compliance case: redemption/transfer per the exit spec (S-05); no freeze needed unless required |

## Offboarding order (never change it)

1. **Freeze** (above). Confirm on chain: `chain.freezes` / token `isFrozen(wallet)`.
2. **Move or redeem the tokens**: forced transfer through `RecoveryGuard.propose(ForcedTransfer, from,
   to, amount, evidenceHash)` by the Trustee Safe, executed after the 48 h delay (`execute`), or a
   redemption burn through `IssuanceGuard.burn(from, amount, refId)` by the Issuance Safe, as the
   legal decision requires. Money owed to the investor stays in the ledger (held), never paid to a
   sanctioned person without legal clearance.
3. **Only when the balance is zero**: delete the identity through the timelock (72 h). Never call
   `updateIdentity` on a wallet that holds tokens (F-02, invariant I-17). Never rely on claim
   revocation (F-01).

## Recovery verification

- Wallet frozen, then balance zero, then identity deleted (in that order), each confirmed on chain
  and in the read model (`npm run indexer:status`, `chain.investors`).
- `npm run kyc:audit` clean; `npm run recon` passes (held payouts show as warnings, not blocking).

## Records and retention

Case file (private store): case id, dates, decisions and officers (also in `kyc.audit`), FMU report
reference, legal advice. KYC records are kept for the retention period (10 years assumed, ADR 0009;
LEGAL TO CONFIRM) even after offboarding; the database already holds no readable CNIC or name.
