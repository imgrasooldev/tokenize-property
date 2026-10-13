# Runbook: suspected key or secret compromise

Severity: **SEV1** until the key's powers are removed. Principle (contract spec section 3): a hot
key can only do things that are safe to do too often; anything that moves or creates value needs a
multisig. So the first question is always: **what can this key do on chain or in the database?**
Threat model K-1..K-7, SC-4, SC-7, KYC-3, SUP-3. Standards: NIST SP 800-57 (key lifecycle), CCSS.

## Trigger

Lost or stolen device or hardware wallet; key material or `.env` content seen in a log, chat,
commit, screenshot or backup; unexpected transactions from a platform address; `AnchorAlarm` for an
unknown anchor; signer audit entries nobody requested; departing staff with access; GitHub secret
scanning alert; suspicious SSH login.

## Immediate actions (all keys)

1. Open a SEV1 incident ([incident-response.md](incident-response.md)). Do not discuss key material
   in chat; never paste a key to "check" it.
2. **Pause the token if any value-moving path might be reachable** (section "Pause" below). Pausing
   is always safe; only the Admin Safe can unpause.
3. Stop the service that uses the key (signer, anchor, bank, web) so it cannot be used through it.
4. Preserve evidence: ad-hoc DB backup, copies of logs, list of recent transactions from the
   key's address (`chain.events`, block explorer for the L2). Do not wipe hosts.
5. Then rotate per key type below. Every on-chain role change goes through the TimelockController
   (72 h in production) unless stated otherwise; the Trustee or Admin Safe can **cancel** a
   malicious timelock operation during the delay, so watch `CallScheduled` events.

## Pause

| Who | How |
|---|---|
| Pauser hot key (on-call) | `PauseGuard.pause("<incident id>")` from the pauser hardware wallet (production) |
| Ops Safe or Admin Safe | `pause(string)` as a Safe transaction |
| Demo server only (dev keys) | `cd ~/property-token; set -a; . chain/network/dev-accounts.env; set +a; PG=$(psql ... -Atc "SELECT address FROM chain.contracts WHERE role='pauseGuard'")` or read `pauseGuard` from the DeployLib broadcast; then `cast send "$PG" 'pause(string)' 'incident' --rpc-url http://127.0.0.1:8545 --private-key "$PAUSER_KEY"`. Dev keys on the demo only; this puts the key on a command line, which is acceptable there and nowhere else |

Unpause: `PauseGuard.unpause()` by the Admin Safe (3-of-5) only (I-10), after the IC and trustee
agree the cause is removed.

## Per key type

| Key | What an attacker can do | Rotation |
|---|---|---|
| **Pauser** (hot) | Pause only (SC-4) | `PauseGuard.setPauser(new)` through the timelock. If the attacker keeps pausing, leave the token paused until the rotation executes (unpausing in between is pointless) |
| **Registrar** (signing service) | Register ≤ 50 identities/hour, only identities that already carry valid claims from our issuer (SC-7) | Stop the signer; `RegistrarGuard.setRegistrar(new)` through the timelock; compare every `InvestorRegistered` since the suspected time with KYC records (`kyc.subjects`, `kyc.wallets`); freeze any unknown wallet via `FreezeGuard` (Ops Safe) |
| **Claim issuer** (KYC claims) | Sign KYC/AML claims for fake identities | Remove the issuer key from the trusted issuer / claim issuer contract (timelock); do **not** rely on claim revocation (F-01): freeze affected wallets and offboard them ([kyc-sanctions-offboarding.md](kyc-sanctions-offboarding.md)); issue a new claim key, one chain only (F-03) |
| **Signer keystore / `SIGNER_MASTER_KEY` / `SIGNER_CLIENT_SECRET_*`** | Sign whatever the keys inside can sign; with the client secret, submit requests (still under policy, limits and maker-checker) | Stop `npm run signer` service; list `signer.keys` and the on-chain roles of each address; rotate each role on chain (above); new keystore with a new master key; new client secret; `npm run signer:audit`; review `signer.requests` and `signer.audit` since the suspected time. No re-encryption tool exists yet (gap, OPERATIONS.md section 9) |
| **Anchor key** | Write anchors (cannot rewrite old ones, block must increase) | Stop the anchor job; `StateAnchor.setAnchorer(new)` by the anchor owner Safe on the public chain (no timelock there); `npm run anchor:verify` flags anchors not in the DB; new key in its own keystore (`ANCHOR_KEYSTORE_DIR`) or the HSM |
| **Safe signer** (hardware wallet of an Admin/Trustee/Issuance/Ops Safe owner) | Nothing alone (thresholds 3-of-5 / 2-of-3); dangerous only together with others | Remaining owners `swapOwner(old → new)` on that Safe at once; review pending Safe transactions and timelock queue; if a threshold of owners may be compromised: pause, have the Trustee/Admin Safe cancel queued timelock operations, escalate to the owner and trustee |
| **Validator node key** | Act as that validator (cannot finalize alone: needs 3 of 4) | Operator replaces the validator: other validators vote it out and the new key in (`qbft_proposeValidatorVote`); node key files are never in backups |
| **CI deploy key** (`DEMO_SSH_KEY_PROPERTY`) | Run `update.sh` for a commit already on `main` (forced command) | Remove the `pt-ci-deploy` line from `~ubuntu/.ssh/authorized_keys`; new key pair; update `deploy/demo-server/ci-deploy.pub` and the GitHub secret; re-run `provision.sh` step for the key |
| **Personal SSH key / GitHub account / Ploi** | Shell (and sudo) on the server; push to branches; Ploi has a root key | Remove the key from `authorized_keys`; revoke GitHub sessions/tokens; rotate Ploi access or disconnect Ploi; review `last`, `journalctl _COMM=sshd`, `/var/log/auth.log`; if root was possible treat the host as compromised (rebuild, rotate every secret on it) |
| **DB passwords** (`PG_ADMIN_PASSWORD`, service roles) | Read and, as admin, change data (triggers can be disabled by a superuser) | `ALTER ROLE ... PASSWORD` (generated); update `backend/.env.local`; restart services; run `npm run recon` and `npm run anchor:verify` to prove the data did not change |
| **`KYC_PEPPER_*`, `KYC_DATA_KEY`, `BANK_DATA_KEY`** | With a DB copy: match CNICs to subjects, unseal names/IBANs | Treat as personal-data breach ([data-breach.md](data-breach.md)); peppers rotate by version (Y-2); re-sealing with a new data key has no tool yet (gap) |
| **`BANK_WEBHOOK_SECRET_*`** | Forge bank notifications (still matched to payment codes, amounts, the investor's own account; reconciled against the bank statement) | Add a new key id, switch the bank to it (two keys during rotation, B-1), remove the old one; review `bank.events` since the suspected time; run recon with a fresh statement |
| **Backup private key** | Decrypt every backup set | New key pair (backup-restore runbook section 2); install the new recipient; re-encrypt nothing old (old sets age out); treat old sets as exposed if the media were also accessible: data-breach assessment |

## Recovery verification

- The compromised address holds no role: check each guard's view (`pauser()`, `registrar()`,
  `anchorer()`, Safe `getOwners()`), and the timelock queue is clean.
- `npm run signer:audit`, `kyc:audit`, `bank:audit`, `recon`, `anchor:verify` clean.
- Token unpaused by the Admin Safe only when the IC and trustee agree.

## Post-incident record

Which key, exposure window, transactions made with it, rotations (tx hashes, timelock ids), who
approved each, and whether the threat model or key policy changes.
