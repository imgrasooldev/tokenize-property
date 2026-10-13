# Product Map

- Version: 0.1
- Date: 2026-10-08

Everything the platform consists of: what each user sees, and the services behind it. "Pilot" means it is needed for the SECP sandbox pilot; "Later" means after the pilot.

## 1. Public-facing

| # | Product | Users | Main features | Tech | Phase |
|---|---|---|---|---|---|
| 1 | **Public website** | Everyone | How it works, live and upcoming properties, risk disclosure, fees, audit reports, Shariah certificate, FAQ; Urdu and English | Next.js (server-rendered for SEO) | Pilot |
| 2 | **Investor web portal** | Investors | Sign-up and KYC, browse offerings, invest, portfolio, rent history, statements and tax certificates, bank account (with 72h cooling-off on changes), documents, support | Next.js, same app as the website, behind login | Pilot |
| 3 | **Investor mobile app** | Investors | Everything in the web portal, plus passkey or biometric login, push notifications, device binding | Flutter (Android and iOS) | Pilot |
| 4 | **Public verification page** | Anyone | Check token supply against the trustee register, check document hashes, check public-chain anchors, verify your own rent entitlement with a Merkle proof | Next.js page reading the chain | Pilot |

## 2. Internal portals

| # | Portal | Users | Main features | Phase |
|---|---|---|---|---|
| 5 | **Operations / admin portal** | Operations staff | Set up offerings, process subscriptions, prepare mint requests, prepare rent distributions, payout reconciliation, investor support. Every money or token action is maker-checker. | Pilot |
| 6 | **Compliance portal** (module of admin) | Compliance officer | KYC review queue, AML and sanctions hits, case files, freeze requests, suspicious transaction reports to FMU, full audit log | Pilot |
| 7 | **Trustee portal** | Trustee officers (e.g. CDC) | Trustee register view, co-sign issuance, review and reject distributions within 48h, recovery requests, daily reconciliation reports | Pilot |
| 8 | **Multisig signing console** | Safe signers (directors, trustee, ops) | Review and sign Safe transactions on hardware wallets | Self-hosted Safe{Wallet} | Pilot |
| 9 | **Property sponsor portal** | Property owners and developers | Submit a property, upload title documents, track due diligence and valuation | Later |
| 10 | **Secondary market** | Investors | Buy and sell tokens between verified investors | Later, only after regulatory approval |

All internal portals are one Next.js app with role-based access, reachable only over VPN with SSO and FIDO2 hardware keys (NIST AAL3). Built as `admin/` ("PT Control"); Step 6a (2026-10-13) delivered sign-in with hardware keys, roles with segregation of duties, the audit trail and the operations overview, see [ADR 0011](decisions/0011-admin-portal.md); approvals 6b, compliance 6c and trustee 6d follow.

## 3. Backend services (no user interface)

| Service | Job |
|---|---|
| API gateway | Single entry point: rate limits, auth, mTLS to internal services |
| Auth service | Passkeys, authenticator apps, device binding, sessions |
| Ledger | Double-entry, append-only, hash-chained record of all money and token movements |
| Signing service | The only component with keys (HSM/MPC in production); policy engine and limits |
| Indexer | Follows chain events and keeps the read database current, so the app never waits for the chain |
| Reconciliation | Daily three-way check: chain vs ledger vs bank; freezes payouts on mismatch |
| KYC service | NADRA Verisys, selfie and liveness, sanctions and PEP screening; isolated database |
| Payments | Bank and Raast integration for subscriptions and rent payouts (PKR only) |
| Notifications | SMS, email, push; alerts on every sensitive account change |
| Document store | Encrypted storage for title deeds, valuations, statements; hashes go on-chain |
| Anchor job | Writes hourly private-chain hashes to the public chain |
| Monitoring | On-chain alerts, SIEM, uptime, dashboards for on-call |

## 4. Blockchain layer

| Part | Status |
|---|---|
| ERC-3643 token suite + our guard contracts | Built and tested (Step 3) |
| Private Besu QBFT network, 4 validators run by separate organisations | Step 4 |
| Public-chain `StateAnchor` | Built and tested; network choice pending |

## 5. Build order

1. Contracts (Step 3, in progress)
2. Local chain (Step 4)
3. Backend services (Step 5)
4. Internal portals: operations, compliance, trustee (Step 6)
5. Investor web portal, public website and verification page (Step 6–7)
6. Investor mobile app (Step 7)
