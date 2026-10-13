# Runbook: incident response

Applies to every incident. The specific runbooks (see [OPERATIONS.md](../OPERATIONS.md) section 8)
say what to do technically; this one says who decides, who talks, and what gets written down.
Standards: NIST SP 800-61 (incident handling), NIST CSF 2.0 Respond/Recover, ISO/IEC 27001:2022
A.5.24–A.5.28, SOC 2 CC7.3–CC7.5.

## Trigger

Any of: a CRIT or repeated WARN alert from `pt-health`, a failed `pt-*` unit, an `AnchorAlarm`, a
reconciliation freeze, a report from an investor, the trustee, the bank or staff, a suspected key,
account or data compromise, or anything that could move value or expose personal data wrongly.
When in doubt, open an incident: closing a false alarm costs minutes.

## Severity

| Level | Meaning | Examples | Acknowledge | Update cadence |
|---|---|---|---|---|
| SEV1 | Value or integrity at risk now, or the chain is down | Suspected key compromise; anchor mismatch; wrong payout sent; chain halted (≥ 2 validators down); personal data exposed | 15 min, all hands | every 30 min |
| SEV2 | Safety control engaged or degraded, no loss yet | Payouts frozen by reconciliation; indexer halted; outbox command with expired lease; restore drill failed; backups failing > 24 h | 30 min | every 2 h |
| SEV3 | Redundancy reduced, users mostly unaffected | One validator down; indexer lag; disk > 80 %; website slow | next working day | daily |
| SEV4 | Cosmetic or hygiene | Warning-level drift, documentation gap | backlog | |

Raise the level the moment new facts justify it; lower it only when the Incident Commander says so.

## Roles

| Role | Does | Notes |
|---|---|---|
| Incident Commander (IC) | Owns the incident, sets severity, decides, keeps the timeline | First responder until handed over |
| Tech lead | Diagnoses and fixes, follows the runbooks | |
| Approver(s) | Maker and checker for any guarded action (unfreeze, signer approval, payout batch, Safe transaction) | Two different people; never the IC acting alone |
| Compliance officer | KYC/AML, FMU reporting, regulator contact, data-protection assessment | Mandatory for SEV1 involving money or personal data |
| Comms lead | Internal updates, trustee, bank, investors, regulator (with compliance) | Uses the templates below |
| Scribe | Timeline with UTC times, commands run, decisions and who made them | Can be the IC in small incidents |

In a small team one person may hold several roles, **except** that maker and checker must be two
different people, and the person who caused or is suspected in an incident does not approve its fix.

## Immediate actions (first 15 minutes)

1. Acknowledge the alert in the channel; name the IC.
2. Classify (table above). Open the incident record (template below) in the private incident store.
3. Contain before you diagnose when value is at risk:
   - token transfers at risk → **pause** through `PauseGuard.pause(reason)` (Pauser key, Ops Safe or
     Admin Safe; see [key-compromise.md](key-compromise.md) section "Pause");
   - payouts at risk → do not approve or submit batches; stop the bank and signer services;
   - a host or key suspected → isolate (stop the service, revoke the SSH key), do not wipe.
4. Preserve evidence: do not delete rows, logs or files; take an ad-hoc backup
   (`sudo systemctl start pt-backup-db.service`) before any repair that writes to the database.
5. Follow the specific runbook.

## Communication

- Internal channel: one thread per incident; updates at the cadence above, even if "no change".
- Trustee: SEV1 and SEV2 involving tokens, distributions or payouts, within 1 hour of confirmation.
- Bank: any payout or Raast incident, immediately (they may be able to stop or recall a payment).
- Investors: only through the comms lead, after compliance review; facts, impact, what they should
  do, no speculation, no personal data of others.
- Regulator (SECP), FMU, FIA cybercrime wing, data-protection authority: through compliance, per
  [data-breach.md](data-breach.md) and [kyc-sanctions-offboarding.md](kyc-sanctions-offboarding.md).
  Deadlines: LEGAL TO CONFIRM.
- Never put secrets, CNIC, names or IBANs into chat, tickets or alerts. Refer to subject IDs.

Update template:

```
[SEV2][OPEN] <short title> · <UTC time>
Impact: <who/what is affected>
Status: <what we know, what is contained>
Next: <next action, owner, ETA of next update>
```

## Recovery verification (before closing)

- `pt-health.sh` OK (or only accepted WARNs), no failed `pt-*` units.
- For data incidents: `npm run recon` passes; `npm run anchor:verify` passes (where anchoring runs);
  `npm run signer:audit`, `kyc:audit`, `bank:audit` clean.
- Payout gate: `npm run recon:status` shows the intended state.
- Token pause state is what the IC decided (unpause only by the Admin Safe).

## Post-incident record

Within 5 working days for SEV1/SEV2 (blameless review):

```
Incident: <id> · Severity · Start / detect / contain / resolve (UTC)
Summary:
Impact: users, money (PKR), tokens, data subjects
Timeline: (scribe's log)
Root cause:
What went well / what did not:
Actions: <owner, due date, task id>   (spec/ADR changes first: CLAUDE.md "change the spec before
         changing behaviour"; threat model updated: docs/threat-model.md)
Evidence: commands run, drill/recon reports, transaction hashes
Approvals: who approved each guarded action
```

Store records in the private incident store (the repository is public). Only a sanitised summary,
if any, goes into the repository (e.g. a finding under `docs/findings/`).
