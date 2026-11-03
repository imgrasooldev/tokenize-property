# Portals

Every screen of the platform: who uses it, how they get in, and what they can do there. Status as of 2026-11-03 (migrations 0001-0048 on `main`, live on the demo server http://51.79.144.40).

Technically there are two web applications: the website `web/` (public site, investor portal, verification, sponsor portal, tenant payment page) and PT Control `admin/` (every internal portal, one app with role-based screens). The mobile app and the multisig console are separate and not built yet.

## Summary

| # | Portal | For | Sign-in | App | Status |
|---|---|---|---|---|---|
| 1 | Public website | Everyone | None | `web/` | Live |
| 2 | Investor portal | Investors | Passkey | `web/` | Live |
| 3 | Public verification | Anyone | None | `web/` `/verify` | Live |
| 4 | Sponsor portal | Property owners' representatives | Passkey (investor account + KYC) | `web/` `/sponsor` | Live (2026-11-03) |
| 5 | Tenant payment page | Tenants | One-time link | `web/` `/pay/<link>` | Live |
| 6 | Operations / admin portal | Platform staff | FIDO2 security key | `admin/` (PT Control) | Live, gaps |
| 7 | Compliance portal | Compliance officers | FIDO2 security key | `admin/` `/compliance` | Live, gaps |
| 8 | Trustee portal | Trustee officers | FIDO2 security key | `admin/` `/trustee` | Live |
| 9 | Investor mobile app | Investors | Passkey / biometrics | Flutter | Design only |
| 10 | Multisig signing console | Safe signers | Hardware wallet | Self-hosted Safe{Wallet} | Not built |

Later, outside the ten: the secondary market (open buy and sell between verified investors), only after regulatory approval. A demo market exists on the website today.

## Website (`web/`)

### 1. Public website

- **For:** everyone, no account.
- **Where:** `/`, `/offerings`, `/properties`, `/search`, offering and property pages; information pages `/faq`, `/fees`, `/risks`, `/about`, `/reports`, `/contact`, `/legal/terms`, `/legal/privacy` (EN/UR; legal text marked as draft until counsel approves it).
- **What it does:** how the platform works; live and upcoming properties with a rule-based score; fees and risk disclosure; property details with public documents (downloaded from the vault, hash checked again); search and a grounded AI analyst that cites documents and never gives advice; English and Urdu.

### 2. Investor portal

- **For:** registered investors.
- **Sign-in:** passkey (WebAuthn). Sessions are kept in the database. Every money move asks for a fresh passkey check (step-up rules in `webauth.step_up_actions`).
- **What it does:**
  - Sign-up and KYC (`/signup`): CNIC, liveness, screening, suitability, payout bank account. A new payout account waits 72 hours.
  - Invest (`/offerings` → subscribe): disclosures recorded, payment by Raast from the investor's own account, units issued after the trustee receives the money; withdrawal within the S-02 window on `/subscriptions`.
  - Portfolio (`/portfolio`): holdings, rent history with Merkle proofs.
  - Transfers between verified investors (`/transfers`), exit and redemption requests (`/exit`), demo market (`/market`, labelled as demo).
  - Account (`/account`): support reference, payout accounts, tax certificates with a printable page and a verifiable download.
  - Notifications (`/notifications`), token-holder votes (`/votes`), complaints (`/complaints`).
  - Link to the sponsor portal when the person represents a sponsor.
- **Open:** auto-reinvest, Roshan Digital Account.

### 3. Public verification (`/verify`)

- **For:** anyone, no account.
- **What it does:** token supply against the trustee register, document hashes, public-chain anchor status, and each investor's own rent entitlement through a Merkle proof.

### 4. Sponsor portal (`/sponsor`)

- **For:** the authorised representatives of property sponsors (directors or owners recorded in the S-01 KYB file), signed in with their own investor account.
- **What it does:** for each sponsor they represent: the KYB state and the team's last message, documents, submit the KYB file; add a property, edit a draft's identifiers, submit it for review or withdraw it with a reason; upload documents (PDF, JPEG, PNG or TIFF, up to 25 MB) through a one-time vault ticket.
- **Rules:** the database checks the person's powers (submit, upload, respond, withdraw), KYC and the file's state. Screening, risk, duplicates and reviewers never reach the website. Reviews, committees and the trustee stay in PT Control.

### 5. Tenant payment page (`/pay/<link>`)

- **For:** tenants of a tokenised property, through a one-time link from an invoice.
- **What it does:** shows amount, due date, reference and the collection account; no sign-in, not indexed, no referrer.
- **Open:** the collection account text is a placeholder until the trustee bank account is confirmed.

## PT Control (`admin/`): internal portals

- **Access:** only through an SSH tunnel on the demo server (127.0.0.1:3300), never through nginx.
- **Sign-in:** FIDO2 security keys only, with a one-time enrolment link per officer.
- **Every decision:** a step-up with the key and a reason, recorded in the audit trail.
- **Money and tokens:** every action is maker-checker; the database refuses the same person on both sides.
- **Roles:** an officer can hold several roles unless the pair is a segregation-of-duties conflict (`admin.role_conflicts`).

### 6. Operations / admin portal

| Role | Who | Screens and powers |
|---|---|---|
| Administrator (`admin`) | IT / security administrators | `/officers`: create officers, give and take roles, enrolment links, property-manager assignments. Every change needs a second administrator. Reads the admin audit. Holds no business power (conflicts with every business role). |
| Platform owner (`platform_owner`) | Directors | Read-only view of operations, approvals, properties, offerings, exits and transfers; `/support` lookups; emergency payout hold (`payouts.hold`), released maker-checker after a new passed reconciliation run. |
| Operations maker (`ops_maker`) | Operations staff | Requests on `/approvals` and `/operations`: payout batches, bank statement import, suspense returns, follow-up batches, signer policy proposals, rent publish and finalize, tenant invoices, document uploads (`/documents`), polls (`/votes`), recovery, exit and transfer requests; committee votes; complaints. |
| Operations checker (`ops_checker`) | Senior operations staff | Decides what makers ask: signer requests (with decoded calldata), payout batches, unfreeze, S-01 property decisions, offering decisions, recovery, exits, rent calculations; transfer cash and price checks; committee votes. |
| Legal officer (`legal_officer`) | Legal team | Decides recovery and succession cases and exits. |
| Tax officer (`tax_officer`) | Tax team | `/tax`: withholding tax, certificates and exports; reads operations. |
| Auditor (`auditor`) | Internal or external auditors | Reads everything (including the admin audit) and exports; changes nothing. |
| Property manager (`property_manager`) | Managers of a building | Only the properties assigned to them and their operating statements; everything else reads as not found. |
| Investor support (`support_agent`) | Support desk | `/support`: find an investor by the 8-hex support reference (no compliance detail); `/complaints`: acknowledge, reply, resolve, refer to compliance. |

- **Onboarding desk** (`/onboarding`, since 2026-11-03, migration 0049): every S-01 maker action on sponsor and property files (KYB evidence, people, submissions, reviews, documents from the vault, title chain, encumbrances, valuations, structure) for officers with the matching S-01 duty; administrators manage S-01 duties and the valuer panel on `/officers`.
- **Open:** creating a sponsor stays on the command line (it seals the name and address with keys the portal does not hold); the 14 demo officers need their own security keys to enrol (owner action).

### 7. Compliance portal

- **For:** compliance officers (`compliance_officer`).
- **What it does:** `/compliance`: KYC and AML queue, sanctions and PEP hits, case files, freeze requests and decisions, exports; S-01 property, offering, recovery, exit and transfer decisions where compliance must agree; committee votes; complaints referred to compliance; full audit log.
- **Transaction monitoring:** `/compliance/monitoring` (migration 0051): rules for structuring, rapid in-and-out, payments above the declared income and many payout-account changes open alerts in a review queue; one officer opens an STR case from an alert, dismissing needs two. Thresholds are placeholders until the MLRO confirms them.
- **goAML:** every STR export carries a goAML STR draft (migration 0050); the reporting entity values and indicator codes are placeholders until the FMU confirms them (set on `/compliance/str`). Filing stays manual by the MLRO.
- **Open:** automatic transaction monitoring (rules that open STR candidates).

### 8. Trustee portal

- **For:** trustee officers (`trustee_officer`), for example the trustee bank's staff.
- **What it does:** `/trustee`: the trustee register, rent distribution review within the 48-hour challenge window, exports; decisions on exits and transfers; approves token-holder polls before they open; reads operations.

## Not built yet

### 9. Investor mobile app (Flutter)

- **For:** investors, everything in the investor portal plus biometrics, push notifications and device binding.
- **Status:** interactive design with 49 screens in three looks at http://51.79.144.40/mockups/app/ (source `docs/design/app/`).
- **Next:** the public API (`/v1`), then the app.

### 10. Multisig signing console

- **For:** Safe signers (directors, trustee, operations), who review and sign multisig transactions on hardware wallets.
- **Status:** not built. Today the signing service signs within policy limits after maker-checker; the self-hosted Safe{Wallet} is part of the production setup.

## Not a portal

- **Demo console:** on the demo server (127.0.0.1:4800, SSH tunnel only) for running demo scenarios.
- **Besu validators:** the four validator nodes are run with `chain/net.py`, not from a screen. Monitoring and alerting are still to come before real money.
