# Operations

How the platform is run, watched, backed up and recovered. Tasks T-035 (monitoring, backups,
runbooks) and the operational part of T-034 (scheduled jobs with alerting).

- Version: 0.1 (2026-10-13). Owner: CTO / SRE. Review: at every step gate and after every incident.
- Scripts and units: [`deploy/ops/`](../deploy/ops). Runbooks: [`docs/runbooks/`](runbooks/).
- Standards: [security-standards.md](security-standards.md) (NIST CSF 2.0 Detect/Respond/Recover,
  ISO/IEC 27001:2022 A.5.24–A.5.30, A.8.13, A.8.15, A.8.16; SOC 2 CC7.2–CC7.5, A1.2–A1.3;
  CIS Controls v8 8, 11, 17). Threat model items closed or advanced here: D-4 (data loss), CH-2
  (validator outage), D-1/D-3 (daily verification scheduled), D-5 (breach runbook).

**Honest status.** This pack makes the *demo server* observable, backed up and recoverable, and
writes down how production must be run. It does not make the demo server production. The list of
what production still needs is in section 9; nothing in it is optional for real money.

## 1. What is in the pack

| Piece | File | What it does |
|---|---|---|
| Encrypted DB backup | `deploy/ops/pt-backup-db.sh` | `pg_dump` (custom format, compressed) of each app database from one exported snapshot, piped straight into encryption to a **public** key (GnuPG by default, `age` optional); globals without password hashes; manifest with exact row counts and migrations; `SHA256SUMS`; integrity sweep of every stored set; retention (all < 48 h, 7 daily, 4 weekly, 12 monthly); optional offsite hook. Plaintext never touches the disk |
| Restore and drill | `deploy/ops/pt-restore-db.sh` | Restores a set into a NEW `pt_restore_*` database in one transaction and proves it: checksums, `ledger.verify_chain()`, `ledger.verify_balances()`, `signer.verify_audit()`, `recon.verify_audit()`, `kyc.verify_audit()`, `bank.verify_audit()`, migrations and exact row counts equal to the manifest. Writes a drill report |
| Besu snapshot | `deploy/ops/pt-besu-snapshot.sh` | One validator at a time, only when all four are healthy; checks the other three keep finalizing; encrypted archive of the chain database (never the node key); waits until the node is back in sync |
| Health check | `deploy/ops/pt-health.sh` | Validators (height progress, peers, lag), indexer (lag, halt), outbox (expired leases, review, stale pending), signer (pending approvals), reconciliation (freeze, last run age and result), anchoring (last confirmed age, failures), backup age, disk, memory, swap, systemd units, HTTP. Exit 0/1/2 = OK/WARN/CRIT, 3 = check broke. Read-only |
| Alert hook | `deploy/ops/pt-alert.sh` | One interface: journal always, plus an optional HTTPS webhook (`{"text": ...}` JSON, works with self-hosted Mattermost/Rocket.Chat or any receiver). URL kept in a 0640 file and never on a command line |
| Job runner | `deploy/ops/pt-job.sh` | Runs an allow-listed backend CLI (`recon`, `anchor:verify`, `indexer:verify`, `signer:audit`, `kyc:audit`, `bank:audit`, status commands) with a timeout, keeps logs, records the result, exits with the job's code |
| Failure backstop | `deploy/ops/pt-unit-failed.sh` + `pt-ops-alert@.service` | `OnFailure=` of every ops unit: any failed unit alerts with its last journal lines |
| Units | `deploy/ops/systemd/` | Timers for health (5 min), backup (daily), recon (daily), anchor verify (daily), audit chains (daily); snapshot template `pt-besu-snapshot@N`. All OFF until enabled |
| Installer | `deploy/ops/install.sh` | Idempotent; copies scripts to root-owned `/usr/local/lib/pt-ops`, installs units, creates `/etc/pt-ops`, `/var/backups/pt`, `/var/lib/pt-ops`; installs the backup public key after refusing any private key |
| Config | `deploy/ops/ops.env.example`, `alert.env.example` | Non-secret settings (parsed, never executed) and the webhook file |

### How the pack was tested (2026-10-13, development laptop, Git Bash + PostgreSQL 18.6)

| Test | Result |
|---|---|
| `bash -n` on every script | Clean. `shellcheck` is not installed on the laptop: run `shellcheck deploy/ops/*.sh` on the server (`apt-get install shellcheck`) or add it to CI (T-014) |
| Backup → restore drill, both local databases | PASS (details and numbers: [backup-restore.md](runbooks/backup-restore.md) section 4) |
| Tampered journal in a backed-up copy | Drill FAILS at `ledger.verify_chain()` (exit 1) |
| One byte changed in an encrypted dump | Refused at `checksums` (exit 1) |
| Restore target not `pt_restore_*`; private key offered as recipient | Refused (exit 2) |
| Retention on 403 synthetic sets over 400 days | Keeps 23 (all < 48 h + 7 daily + 4 weekly + 12 monthly, overlapping) |
| Health check against the local chain and DB | Validators, chain progress, indexer lag, outbox, signer, recon (no run yet → WARN), anchors (N/A) reported correctly; read-only |
| Alert hook against a local receiver | Valid JSON with quotes, backslashes, newlines, Urdu; control characters dropped; HTTPS enforced; failures exit 1; health alerts once, de-duplicates, then sends RESOLVED |
| Job runner | `signer:audit` passed through the wrapper; a non-allow-listed job refused (exit 2) |
| Besu snapshot | `--dry-run` only (reads RPC). The stop/archive/restart path was **not** run against the shared local chain; first real run belongs on the demo server, supervised |
| systemd units, `install.sh` | Not executable on Windows; first run on the demo server (section 5) |

### Schedule (server clock UTC; Pakistan time = UTC+5)

| Timer | UTC | PKT | Why then |
|---|---|---|---|
| `pt-ops-health.timer` | every 5 min | | |
| `pt-backup-db.timer` | 21:15 daily | 02:15 | Quiet hours; before reconciliation |
| `pt-recon.timer` | 22:00 daily | 03:00 | After the PKT midnight bank cut-off (ADR 0007); the gate needs a passed run younger than 26 h |
| `pt-anchor-verify.timer` | 22:30 daily | 03:30 | After recon |
| `pt-audit-chains.timer` | 23:00 daily | 04:00 | `signer:audit`, `kyc:audit`, `bank:audit` |
| `pt-besu-snapshot@N` | manual | | Monthly, one node per run; never on a timer while 4 validators share one host |

## 2. Environments

| | Local (developer laptop) | Demo server (`51.79.144.40`) | Production (target) |
|---|---|---|---|
| Purpose | Development and tests | Private demo, no real users or money | Real investors, real PKR |
| Chain | 4 Besu validators on one machine, chain 586586, dev keys | Same as local, on one 4 GB VPS | 4 validators run by 4 organisations on separate hosts, production chain ID, TLS between nodes |
| Database | PostgreSQL 18 on 127.0.0.1:5433, admin user | Same | Managed or self-run PostgreSQL with TLS, per-service roles, a streaming replica, WAL archiving (PITR), separated DBA access |
| Keys | Local encrypted keystores, dev keys in git-ignored files | Same (generated on the server, never leave it) | HSM/MPC (ADR 0005, T-032); Safes on hardware wallets |
| Web | `next dev` | Production build behind nginx, **plain HTTP** | TLS 1.3, HSTS, WAF/DDoS edge |
| Admin and console | 127.0.0.1 | 127.0.0.1, SSH tunnel | VPN + SSO + FIDO2 (INF-2) |
| Backups | none needed | This pack (local disk; offsite optional) | This pack's design with PITR, offsite immutable copies in two locations, quarterly drills |
| Monitoring | none | This pack (journal + optional webhook) | Central metrics and logs, SIEM, 24/7 on-call |

## 3. Proposed recovery targets (OWNER TO CONFIRM)

RPO = how much data may be lost. RTO = how long until the service is back. Demo values are what
this pack achieves; production values are proposals that drive the production design.

| Component | Demo RPO / RTO | Production RPO / RTO (proposed) | How |
|---|---|---|---|
| Ledger and all money/identity tables (PostgreSQL) | 24 h / 4 h | **≤ 5 min / 1 h** (replica failover), 4 h from backup | Daily encrypted dump now; production adds WAL archiving (pgBackRest or WAL-G) + a synchronous or near-synchronous replica |
| Private chain state | 0 while ≥ 3 validators keep data / 2 h per validator | 0 / 1 h per validator, 30 min to restore finality | QBFT replicates every block to all validators; a lost node resyncs from peers or from a snapshot |
| Read model (`chain` schema) | rebuildable / 1 h | rebuildable / 1 h | Rebuilt from the chain by the indexer; never restored blindly |
| Public anchors | 0 (public chain) | 0 | The L2 is the backup of the anchors |
| Website and services | 0 (git) / 1 h | 0 / 30 min | Redeploy an exact commit |
| Secrets (`.env` values, keystores) | escrowed copy / 1 business day | HSM key ceremony / 1 business day | Separate custody (section 6, backup-restore runbook) |
| KYC documents | not built (T-038) | TBD with the vault | |

A restored database always loses the journals written after the backup. The chain and the bank
statements are independent records: after a restore, `npm run recon` shows exactly what is missing,
and nothing is paid until it is booked through maker-checker and a run passes (see
[backup-restore.md](runbooks/backup-restore.md)).

## 4. Monitoring and alerts

`pt-health.sh` lines and what to do:

| Line starts with | Severity | Runbook |
|---|---|---|
| `chain: ... chain halted` or `validators down` > 1 | CRIT, SEV1 | [chain-validator-down.md](runbooks/chain-validator-down.md) |
| `validator N: not reachable / behind / peers` | WARN, SEV3 | [chain-validator-down.md](runbooks/chain-validator-down.md) |
| `indexer ...: HALTED` | CRIT, SEV2 | [indexer-halt.md](runbooks/indexer-halt.md) |
| `indexer ...: blocks behind` | WARN/CRIT | [indexer-halt.md](runbooks/indexer-halt.md) (lag section) |
| `outbox: ... expired lease` / `in review` / `pending` | CRIT / WARN | [payout-incident.md](runbooks/payout-incident.md) section "stuck commands" |
| `signer: ... waiting for approval` | WARN | Approvers decide with `npm run signer:decide` (maker-checker) |
| `recon: payouts FROZEN` / `last run ... error` | CRIT, SEV2 | [reconciliation-freeze.md](runbooks/reconciliation-freeze.md) |
| `anchor: ...` | WARN/CRIT | [anchor-alarm.md](runbooks/anchor-alarm.md) |
| `backup: ...` | WARN/CRIT | [backup-restore.md](runbooks/backup-restore.md) |
| `disk`, `memory`, `swap` | WARN/CRIT | [chain-validator-down.md](runbooks/chain-validator-down.md) section "host resources" |
| `unit X: failed` | CRIT | `journalctl -u X`; the job's runbook (recon, anchor, backup) |
| `http ...` | CRIT | [deploy-rollback.md](runbooks/deploy-rollback.md) |

Alerting: `pt-health.sh --alert` sends when the set of failing checks changes, repeats every
`PT_ALERT_REPEAT_MIN` (60) minutes while not OK, and sends `RESOLVED` when everything is OK again.
State is recorded only after a delivered alert, so a webhook outage is retried every run. Every
other unit alerts through `OnFailure=`. Without a webhook, alerts are only in the journal:
`journalctl -t pt-alert` is not enough for anyone to be woken up, so **choosing the alert channel is
an owner decision (section 10)**.

Alert content rule: states, counts, ages, block numbers, unit names. Never secrets, never CNIC,
names, IBANs or wallet-to-person links. The scripts are written to that rule; keep it when editing.

## 5. Installing on the demo server (lead)

Run on the server as `ubuntu` from the repository checkout, after the branch is merged and
deployed (`update.sh` has checked out a commit that contains `deploy/ops`).

```bash
# 0. Once, OFFLINE (not on the server): create the backup key pair and keep the private key off
#    every server; see docs/runbooks/backup-restore.md section 2. Copy ONLY the public key up:
#    ssh ubuntu@51.79.144.40 'cat > /tmp/pt-backup-recipient.asc' < pt-backup-recipient.asc

# 1. Install scripts, units and config (nothing is enabled yet)
cd ~/property-token
sudo bash deploy/ops/install.sh --recipient /tmp/pt-backup-recipient.asc
rm /tmp/pt-backup-recipient.asc
#    Compare the printed fingerprint with the key custodian's record.

# 2. Review /etc/pt-ops/ops.env (paths, HTTP checks). Optional: webhook URL in /etc/pt-ops/alert.env
sudoedit /etc/pt-ops/ops.env
sudoedit /etc/pt-ops/alert.env

# 3. Try each piece by hand once
/usr/local/lib/pt-ops/pt-health.sh; echo "exit $?"          # as ubuntu, read-only
sudo systemctl start pt-backup-db.service && journalctl -u pt-backup-db -n 20 --no-pager
/usr/local/lib/pt-ops/pt-besu-snapshot.sh 4 --dry-run        # as ubuntu (never root), read-only

# 4. Enable the timers that make sense today
sudo bash deploy/ops/install.sh --enable health,backup
#    recon, anchor-verify, audit-chains: only after Step 5h runs the indexer on the demo and books
#    rent/mint journals; before that, recon FAILS by design every day (MEMORY section 5) and
#    anchor:verify has no anchor stand-in on the server.
sudo bash deploy/ops/install.sh --enable recon,anchor-verify,audit-chains   # later
```

Hook-in points for later (lead's decision, not done here because those files belong to other work):

| File | Where | Line to add |
|---|---|---|
| `deploy/demo-server/provision.sh` | after the "systemd units" step | `bash "$APP/deploy/ops/install.sh"` (installs, enables nothing) |
| `deploy/demo-server/update.sh` | after the nginx step, before the smoke test | `sudo bash deploy/ops/install.sh` (refreshes `/usr/local/lib/pt-ops`; timers keep their state) |
| `deploy/demo-server/update.sh` | before migrations, when the commit adds a migration | `sudo systemctl start pt-backup-db.service` (pre-migration backup; kept by the 48 h rule) |

Memory on the 4 GB server: the health check is shell + one `psql` session (a few MB, about 10 s
including a 6 s block sample); the backup is `pg_dump` + `gpg` (tens of MB); `recon` starts a Node
process (about 200–300 MB) once a day. None overlap by schedule.

## 6. Secrets and keys: what is backed up where

| Item | In the DB backup? | Custody |
|---|---|---|
| Ledger, outbox, signer records, read model, recon, anchor, KYC (hashes, sealed names), bank records | Yes, encrypted | Backup sets (server + offsite) |
| Backup private key | No | Offline: two hardware tokens or paper copies in two separate safes; passphrase held by a different person (backup-restore runbook) |
| `backend/.env.local` (DB admin password, `SIGNER_MASTER_KEY`, `SIGNER_CLIENT_SECRET_*`, `KYC_PEPPER_*`, `KYC_DATA_KEY`, `BANK_DATA_KEY`, `BANK_WEBHOOK_SECRET_*`, `ANCHOR_KEYSTORE_PASSPHRASE`) | **Never** | Escrow copy sealed separately from the backups. Without `KYC_DATA_KEY` the sealed names in a restored DB cannot be read; without the peppers no CNIC can be matched again |
| `web/.env.local` (session, wallet-encryption, CNIC-pepper secrets) | Never | Same escrow |
| Signer and anchor keystores (`backend/data/keystore*`, AES-256-GCM, scrypt) | Never | Keystore file in vault A, its passphrase/master key in vault B (two custodians). Production: HSM/MPC key ceremony instead |
| Validator node keys (`chain/network/generated/nodes/*/key`) | Never (also excluded from Besu snapshots) | Each validator operator; a lost key means replacing that validator by QBFT vote |
| Dev role keys (`chain/network/dev-accounts.env`) | Never | Demo only, worthless by design |

## 7. On-call basics

- Rota: one primary and one secondary per week; hand-over notes on Monday. Before go-live this is
  the engineering team in working hours plus best effort; production needs 24/7 for SEV1.
- Response targets (proposed): SEV1 15 min to acknowledge, all hands; SEV2 30 min; SEV3 next
  working day; SEV4 backlog. Definitions: [incident-response.md](runbooks/incident-response.md).
- The on-call engineer may: pause the token with the Pauser key (pause only, never unpause), stop
  services, take ad-hoc backups, start validators. They may **not** alone: unfreeze payouts, approve
  signer requests or payout batches, clear an indexer halt, change Safe owners or roles. Those are
  maker-checker or Safe actions.
- Access the on-call needs: SSH key to the server (personal, not the CI key), the console tunnel,
  the alert channel, the runbooks, phone numbers of the approvers, trustee and bank contacts.
- Every page gets an incident record (incident-response runbook). Incident records with details
  stay in a **private** store: this repository is public.

## 8. Runbooks

| Runbook | When |
|---|---|
| [incident-response.md](runbooks/incident-response.md) | Every incident: severity, roles, communication, record |
| [chain-validator-down.md](runbooks/chain-validator-down.md) | Validator down, chain halted, host out of memory or disk |
| [indexer-halt.md](runbooks/indexer-halt.md) | Indexer halted (hash or chain mismatch, invariant), lag |
| [anchor-alarm.md](runbooks/anchor-alarm.md) | `AnchorAlarm` (exit 3), `anchor:verify` mismatch, anchors stopped |
| [reconciliation-freeze.md](runbooks/reconciliation-freeze.md) | Payouts frozen, recon failed or errored, maker-checker unfreeze |
| [key-compromise.md](runbooks/key-compromise.md) | Suspected compromise of any key or secret |
| [payout-incident.md](runbooks/payout-incident.md) | Wrong batch, returned payments, held payouts, stuck outbox commands |
| [kyc-sanctions-offboarding.md](runbooks/kyc-sanctions-offboarding.md) | Sanctions hit, possible match, offboarding order |
| [data-breach.md](runbooks/data-breach.md) | Personal data exposure (PECA, data protection: LEGAL TO CONFIRM) |
| [deploy-rollback.md](runbooks/deploy-rollback.md) | Deploys, failed deploys, rollback, migration rules |
| [backup-restore.md](runbooks/backup-restore.md) | Backup key ceremony, drills, real restore, Besu snapshots, key custody |
| [demo-vs-production.md](runbooks/demo-vs-production.md) | What differs on the demo server and why |
| [trustee-operations.md](runbooks/trustee-operations.md) | Trustee co-signing, distribution review in the 48 h window, register differences (Step 6d) |

## 9. Demo-only today, and what production needs (gap list)

| Area | Demo today | Production needs | Task |
|---|---|---|---|
| Transport | Plain HTTP on port 80 (`WEB_PLAIN_HTTP=1`, no Secure cookies, no HSTS) | TLS 1.3 everywhere, HSTS, a domain, WAF/DDoS edge | T-030, INF |
| Keys | Dev keys and local encrypted keystores on the same host as the app; `WEB_DEMO_SIGNER=1` | HSM/MPC (FIPS 140-3 L3), Safes on hardware wallets, key ceremonies | T-032, T-039 |
| Validators | 4 validators on one 4 GB VPS, one operator, one disk: one host failure stops the chain and can lose all chain data | 4 organisations, 4 hosts, separate networks and keys; TLS between nodes | Step 4 production |
| Single server | Web, DB, chain, console, ops on one VPS; no replica | Separate tiers, private subnets, mTLS, DB replica | INF-1 |
| Admin access | SSH as `ubuntu` with sudo; CI deploy key can run `update.sh`, which uses sudo, so **whoever can merge to `main` effectively has root on the demo server** | VPN + SSO + FIDO2, separated deploy identity (OIDC), no standing root, change approval | INF-2, SUP-3, T-014 |
| DB access | Services and ops scripts use the PostgreSQL admin role | Per-service roles (exist in migrations), a backup role with `pg_read_all_data`, TLS (`PG_SSL=require`), audited DBA access | T-012 |
| Backups | Daily logical dump on the same disk; offsite only if the hook is configured | PITR (WAL archiving), offsite copies in two locations with object lock / append-only, quarterly restore drill with evidence | D-4 |
| Monitoring | Health script + journal + optional webhook | Metrics (Prometheus or equivalent) with history, central logs, SIEM with alert rules for admin actions and key use, 24/7 paging, synthetic checks from outside | T-035 follow-up |
| Scheduling | Indexer, outbox, signer, bank, anchor are not running as services on the demo yet (Step 5h adds them) | All workers supervised, with health endpoints and restart limits | T-034 |
| Anchoring | Local Anvil stand-in only (not on the demo server) | Public L2 chosen by the owner, anchor key in the HSM | T-033 |
| Manual payout stop | No "freeze payouts now" switch: the gate freezes only from a reconciliation run; the stop is "do not approve, stop the bank and signer services" | A maker-checker manual freeze in `recon` (proposal for the lead) | new |
| Secrets rotation | Bank webhook keys and KYC peppers support rotation; `KYC_DATA_KEY`/`BANK_DATA_KEY` re-sealing has no tool; signer master key rotation has no tool | Documented, tested rotation for every secret | new |
| Ops scripts lint | `bash -n` only (shellcheck not available on the development laptop) | `shellcheck` in CI | T-014 |
| Ploi | Server also connected to Ploi (root key, UFW, a mail relay) | No third-party root access on production hosts | owner |

## 10. Owner decisions needed

1. Confirm or change the RPO/RTO targets in section 3.
2. Alert channel: which HTTPS webhook receiver (self-hosted Mattermost/Rocket.Chat, a chat
   workspace, or SMS/phone through a provider) and who is paged for SEV1 at night.
3. Offsite backup location(s): provider and region (data-localisation rules for personal data in
   Pakistan: LEGAL TO CONFIRM), immutability (object lock or append-only host), and budget.
4. Who holds the backup private key and its passphrase (two different people), and where.
5. Whether the demo server should get offsite backups at all (demo data only).
