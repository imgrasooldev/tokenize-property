# S-08 Roshan Digital Account investors (non-resident Pakistanis)

- Status: Draft, owner approved the defaults on 2026-11-04 ("Yes, start"). LEGAL / SBP / SECP / TAX TO CONFIRM where marked.
- Builds on: ADR 0009 (KYC and bank: NADRA, liveness, sanctions, payment codes, payout accounts B-4, held payouts), ADR 0011 (PT Control, compliance maker-checker), migration 0019 (`kyc.subject_status`, compliance cases), 0053 (neutral investor notice), 0055 (assisted payout accounts).
- Scope: a Pakistani living abroad (NICOP or POC holder) invests through the platform with money from, and back to, their own Roshan Digital Account (RDA) at a participating Pakistani bank.

## 1. Rules

- **RD-1 Who.** A non-resident investor holds a NICOP (Pakistani citizen abroad) or a POC (Pakistan Origin Card). Both carry the same 13-digit identity number as a CNIC and are verified through NADRA like a CNIC (mock: same last-digit conventions). Residency is recorded per investor: `resident` (CNIC, default) or `non_resident` (NICOP or POC), with the country of residence (ISO 3166-1 numeric, never 586) and a proof of residence (document hash in the vault, optional at sign-up). LEGAL TO CONFIRM: whether foreign nationals of Pakistani origin (POC) may hold the units.
- **RD-2 Risk.** A non-resident investor is high risk by default: whatever the automatic checks say, the investor reads `review` (not verified) until **two different compliance officers** approve the residency review in PT Control (one proposes, a second confirms; reason, digest, step-up). A rejection revokes the verification (protective, `kyc.revoke`). Until approved no gate (offering, mint, transfer, payout) treats the investor as verified, and the website shows only the neutral "being reviewed" notice (migration 0053; tipping-off rules unchanged).
- **RD-3 Money in.** A non-resident pays only from an RDA registered as their payout account. A credit from any other account (including an old domestic account of the same investor) goes to suspense with the reason "a non-resident investor pays from their Roshan Digital Account" and is returned by the existing suspense return (0038).
- **RD-4 Money out.** Rent, refunds, exit proceeds and transfer proceeds of a non-resident go only to their active RDA payout account (repatriable). Without an active RDA account the payout line is held (existing held payouts, ADR 0009), never paid to another account.
- **RD-5 Which accounts are RDAs.** The bank's account inquiry says whether an account is an RDA (title inquiry extended with the account kind). A non-resident can register only an RDA as payout account (website, assisted change in PT Control). Mock convention until a bank is contracted: an account whose 16-digit account number starts with `9` is an RDA.
- **RD-6 Currency.** PKR RDAs only in phase 1. Foreign-currency RDAs (conversion, rate source, FX gain/loss) are out of scope until the partner bank and SBP rules are settled.
- **RD-7 On chain.** The identity's country stays **586** (Pakistani national or of Pakistani origin) so the CountryAllowModule needs no change; residence is off chain only.
- **RD-8 Tax.** Non-residents get the existing filer / non-filer withholding (an investor not on the ATL pays the non-filer rate, the conservative default). TAX TO CONFIRM: a separate non-resident rate or treaty relief; then add a tax status, never edit the seeded rates.
- **RD-9 Change of residency.** A resident who moves abroad (or returns) records a new residency; a move to non-resident starts a new two-officer review (RD-2) and RD-3/RD-4 apply at once. History is append-only.

## 2. Screens

- Website (EN/UR): sign-up asks "I live outside Pakistan (Roshan Digital Account)" with document type (NICOP or POC) and country of residence; the account page shows the residency and that payouts go to the RDA; the payout-account form refuses a non-RDA account for a non-resident with a clear message; the invest page says "pay from your Roshan Digital Account".
- PT Control: `/compliance/residency` lists open residency reviews and the non-resident investors (residence country, payout account kind, suspense credits caused by RD-3); `/compliance/residency/[id]` proposes, confirms or rejects.

## 3. Open questions (owner, legal, SBP/SECP, tax)

- Q-1 SBP/SECP: may RDA funds be invested in these units (RDA investment avenues), and is a special approval or listing needed? LEGAL TO CONFIRM before real money.
- Q-2 Partner bank(s) for RDA collection and payout, and their account-kind inquiry.
- Q-3 Non-resident withholding rate, treaty relief, and the certificate the investor needs abroad.
- Q-4 Foreign-currency RDAs (RD-6).
- Q-5 POC holders as unit holders (RD-1).
