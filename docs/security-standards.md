# Security Standards Baseline

- Version: 0.1
- Date: 2026-10-08
- Owner: CTO / security engineer

This project follows internationally recognised security standards, not home-made checklists. This document maps each layer of the system to the standard it must meet, the target level, and how compliance is proven.

**Rule:** a step gate (see README) cannot pass until the standards for that step are met and the evidence is in the repo or the audit folder.

## 1. Standards we follow

### 1.1 Smart contracts

| Standard | Target | Proof |
|---|---|---|
| **EEA EthTrust Security Levels** (Enterprise Ethereum Alliance) | Level **[Q]** (highest: Specified + Manual + Quality) | Self-assessment in `docs/audit/ethtrust-checklist.md`, then confirmed by external auditors |
| **OWASP Smart Contract Security Verification Standard (SCSVS)** | All applicable controls | Checklist mapped to code and tests |
| **OWASP Smart Contract Top 10** | Every item addressed | Covered by tests and Slither detectors |
| **ERC-3643** | Full conformance of the token suite | Official implementation, pinned release |
| Two independent external audits + formal verification of guards | Zero open critical or high findings | Published audit reports |

### 1.2 Backend, APIs and admin panel

| Standard | Target | Proof |
|---|---|---|
| **OWASP ASVS 5.0** (Application Security Verification Standard) | **Level 3** (for high-value financial applications) | ASVS checklist per release; external pen test against ASVS |
| **OWASP API Security Top 10** | Every item addressed | Automated authz tests + pen test |
| **NIST SP 800-63B** (digital identity, authentication) | **AAL2** for investors (passkey or authenticator app); **AAL3** for staff and admins (FIDO2 hardware keys) | Auth design review + pen test |

### 1.3 Mobile app

| Standard | Target | Proof |
|---|---|---|
| **OWASP MASVS 2** (Mobile Application Security Verification Standard) | All L2 controls + **RESILIENCE** (anti-tamper, root/jailbreak detection, integrity attestation) | MASTG-based test before each store release |

### 1.4 Keys and custody

| Standard | Target | Proof |
|---|---|---|
| **CCSS** (CryptoCurrency Security Standard) | **Level III** (highest) | CCSS self-assessment, then external CCSS auditor |
| **FIPS 140-3** HSMs | **Level 3** for production signing keys | HSM vendor certificate |
| **NIST SP 800-57** (key management) | Key lifecycle: generation, rotation, revocation, destruction | Key management policy + ceremony records |

### 1.5 Software supply chain and development process

| Standard | Target | Proof |
|---|---|---|
| **NIST SSDF** (SP 800-218, Secure Software Development Framework) | All practices (PO, PS, PW, RV) | SSDF mapping in this repo |
| **SLSA** (Supply-chain Levels for Software Artifacts) | **Build Level 3** | Signed provenance for every build |
| **OpenSSF Scorecard** | Score 8+ on the repository | Scorecard run in CI |
| **OWASP SAMM** (Software Assurance Maturity Model) | Maturity level 2+ in all practices before launch | Yearly SAMM assessment |

### 1.6 Infrastructure

| Standard | Target | Proof |
|---|---|---|
| **CIS Benchmarks** | Level 1 for all servers, PostgreSQL, containers and cloud accounts; Level 2 for signing service hosts | Automated benchmark scan |
| **CIS Controls v8** | Implementation Group 3 (highest) | Controls mapping |

### 1.7 Organisation (company-level, needed before public launch)

| Standard | Target | Proof |
|---|---|---|
| **ISO/IEC 27001:2022** | Certification | External certification audit |
| **SOC 2 Type II** | Security, availability, confidentiality, processing integrity | External auditor report |
| **ISO/IEC 27701** | Privacy extension to 27001 | External certification |
| **NIST CSF 2.0** | Govern, identify, protect, detect, respond, recover | Used as the top-level risk framework |

### 1.8 Compliance (financial crime and local law)

| Standard / law | Scope |
|---|---|
| **FATF Recommendations** (incl. R.10 customer due diligence, R.15/16 virtual assets and travel rule) | KYC, AML, transaction monitoring |
| **Pakistan AML Act 2010**, FMU reporting | Suspicious transaction reports |
| **SECP** (REIT regulations or regulatory sandbox), **PVARA** rules as they are issued | Licensing and conduct |
| **PECA 2016** and Pakistan data-protection rules | Cybercrime and personal data |

**Important:** code can be built to meet these standards, but certifications (ISO 27001, SOC 2, CCSS, EthTrust) are awarded only by external auditors and also cover company processes, staff and policies. Budget and plan for them from now.

## 2. Standards per development step

| Step | Standards that must be met at the gate |
|---|---|
| 1 Repo and CI | SSDF (PO, PS), OpenSSF Scorecard, secret scanning |
| 2 Specs | Threat model (STRIDE) complete; NIST CSF risk mapping |
| 3 Contracts | EthTrust [Q] self-assessment, SCSVS, Smart Contract Top 10, 100% branch coverage on guards, invariants I-1 to I-16 passing, Slither clean |
| 4 Chain | CIS Benchmarks on nodes; TLS between nodes; node allowlist |
| 5 Backend | ASVS L3, API Top 10, NIST 800-63B, CCSS III design for signing service |
| 6 Admin panel | ASVS L3, AAL3 staff authentication |
| 7 Mobile app | MASVS L2 + RESILIENCE |
| Pre-launch | Two contract audits, external pen test, SLSA L3, CIS IG3, ISO 27001 and SOC 2 programmes started |

## 3. Security definition of done (every pull request)

A PR can merge only if all of these are true:

- [ ] Spec or ADR updated if behaviour changed
- [ ] Threat model updated if a new asset, flow or trust boundary was added
- [ ] Tests written for the change, including failure and abuse cases
- [ ] CI green: tests, coverage, static analysis (Slither / Semgrep), secret scan, dependency scan
- [ ] No new dependency without justification in the PR description
- [ ] No secrets, keys or personal data in code, logs or test fixtures
- [ ] Two approving reviewers; for contracts, one must be a senior Solidity reviewer
- [ ] Signed commits

## 4. Review

This baseline is reviewed every 6 months and whenever a listed standard publishes a new version.
