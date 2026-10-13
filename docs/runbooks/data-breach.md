# Runbook: data breach or personal data exposure

Personal data: CNIC, names, selfies/liveness evidence, phone, e-mail, IBANs, the link between a
person and a wallet, and anything that identifies an investor. Severity: **SEV1**. Compliance
officer leads with the IC. Threat model A4, D-2, D-5. Standards: ISO/IEC 27001:2022 A.5.24–A.5.28,
A.5.34; ISO/IEC 27701.

> **LEGAL TO CONFIRM.** Pakistan's applicable rules must be confirmed by counsel before go-live:
> the Prevention of Electronic Crimes Act 2016 (PECA: unauthorised access and data offences,
> reporting to the FIA Cybercrime Wing), the status and duties of a personal data protection law
> (bill, authority, notification deadlines, data-localisation), SECP requirements for regulated
> entities and sandbox participants (incident reporting, cyber-security guidelines), State Bank
> rules that bind the trustee bank, NADRA Verisys terms of use (breach notification), and contract
> duties to the trustee and bank. This runbook marks where each decision is needed; it does not
> give legal deadlines.

## Trigger

Data seen where it should not be (public repo, chat, logs, a third party); lost or stolen laptop or
backup media; unauthorised database or server access; an investor sees another investor's data; a
vendor reports a breach; a backup set or the backup private key exposed; `.env` secrets exposed.

## Immediate actions (first hour)

1. SEV1 incident; IC + compliance officer; small need-to-know group.
2. **Contain**: revoke access (SSH keys, DB roles, tokens), take the leaking endpoint offline,
   remove public copies (and request takedown/cache removal), rotate exposed secrets
   ([key-compromise.md](key-compromise.md)). For a public git commit: rotate first, then rewrite
   history only with the lead (rotation is what protects; history rewrite does not).
3. **Preserve evidence**: logs (`journalctl`, nginx logs, PostgreSQL logs with `log_connections`),
   DB backup, timeline. Do not wipe hosts.
4. Start the record: what data, how many subjects, which fields, since when, who could see it.

## Assessment: what is actually exposed

The database is designed so that a dump alone reveals little (Y-1):

| Exposed | Without the keys | With the keys (`.env.local` / KMS) |
|---|---|---|
| `kyc` schema | Keyed hashes of CNICs and names, last 4 digits, sealed names, evidence hashes | `KYC_PEPPER_*`: CNICs can be confirmed by guessing; `KYC_DATA_KEY`: names readable |
| `bank` schema | Keyed IBAN hashes, sealed IBANs, amounts, payment codes | `BANK_DATA_KEY`: IBANs readable |
| `chain` schema, ledger | Wallet addresses, amounts, distributions (also on the private chain) | Linkable to people only together with KYC data |
| Web demo schema (`webdemo`) | Demo personas; encrypted custodial demo wallets | `web/.env.local` secrets: demo wallet keys |
| Backup sets | Encrypted (public-key) | Backup private key: everything in the DB |

So the key question is always: **were the secrets exposed together with the data?** Record it.

## Decision points

| Question | Owner |
|---|---|
| Is it a personal data breach (confidentiality, integrity or availability of personal data)? | Compliance |
| Notify the regulator / data-protection authority, within what deadline? | Compliance + counsel (LEGAL TO CONFIRM) |
| Report a PECA offence to the FIA Cybercrime Wing? | Compliance + counsel |
| Notify affected investors? What do they need to do (watch for SIM-swap, phishing, bank fraud)? | Compliance + comms |
| Notify trustee, trustee bank, NADRA, other vendors under contract? | Compliance |
| Freeze accounts or payouts at risk (payout redirection, M-1)? | IC + payout approvers (maker-checker) |

## Recovery verification

- Access paths closed; secrets rotated; `pt-health` OK.
- No further access in logs for an agreed monitoring period.
- `npm run kyc:audit`, `bank:audit`, `recon` clean (data integrity, not only confidentiality).

## Post-incident record

Kept in the private store, with legal privilege where counsel advises: categories and number of
data subjects, fields, exposure window, secrets involved, notifications made (to whom, when,
reference), investor communications, root cause, controls added. Update the threat model (D-2,
D-5) and, if needed, ADR 0009.
