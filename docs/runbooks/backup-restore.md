# Runbook: backups, restore drill, real restore, Besu snapshots and key custody

Threat model D-4 (data loss), D-2 (encrypted backups), CH-2. Standards: ISO/IEC 27001:2022 A.8.13,
SOC 2 A1.2–A1.3, CIS Controls v8 control 11, NIST SP 800-34 (contingency planning).

## 1. What is backed up, and what never is

| Data | Backup | Notes |
|---|---|---|
| App database(s) (`PT_PG_DATABASES`, default `property_token`) | `pt-backup-db.sh`, daily | Custom-format `pg_dump`, compressed, encrypted to a public key; exact row counts from the same snapshot |
| Roles and grants | `globals.sql.<gpg|age>` in every set | `--no-role-passwords`: no password hashes; set service passwords from the secret store after a restore |
| Besu chain data | `pt-besu-snapshot.sh`, manual, one node at a time | Chain database only, never the node key |
| Read model (`chain` schema) | Inside the DB dump | After a restore it is verified (and if needed rebuilt) from the chain, never trusted blindly |
| `.env.local` files, keystores, node keys, backup private key | **Never in a backup set** | Separate custody (section 6) |

A set lives in `/var/backups/pt/sets/<UTC id>/`: `<db>.dump.gpg`, `globals.sql.gpg`, `manifest.txt`,
`SHA256SUMS`. Retention: every set younger than 48 h, plus the newest set of each of the last 7
days, 4 ISO weeks and 12 months. Every run re-checks the SHA-256 of every stored set.

The demo server keeps sets on its own disk. **A backup on the same disk is not a disaster backup.**
Production: an offsite copy through `PT_OFFSITE_HOOK` (an executable that receives the set
directory), in two locations, immutable (object lock or an append-only `rrsync -wo` target), with
its own monitoring (owner decision, OPERATIONS.md section 10).

## 2. Backup key ceremony (once, and on every key rotation)

Done on an offline machine by the key custodian with a witness. GnuPG 2.2+ (Ubuntu, Debian, Git for
Windows) or `age` 1.1+ (`apt-get install age`; Ubuntu 24.04 universe).

```bash
export GNUPGHOME=$(mktemp -d)            # on the OFFLINE machine
gpg --quick-generate-key "pt-backup-2026 <backup@your-domain>" ed25519 cert 2y
FPR=$(gpg --with-colons --list-keys | awk -F: '$1=="fpr"{print $10; exit}')
gpg --quick-add-key "$FPR" cv25519 encr 2y
gpg --armor --export "$FPR" > pt-backup-recipient.asc            # PUBLIC: goes to the server
gpg --armor --export-secret-keys "$FPR" > pt-backup-SECRET.asc   # PRIVATE: never online
```

- Protect the private key with a strong passphrase (the ceremony prompts). Store the secret key on
  two encrypted USB media or hardware tokens (OpenPGP smartcard) in two separate safes; the
  passphrase is held by a **different** person (split knowledge, NIST SP 800-57).
- Record the fingerprint in the key register. Install the public key on the server:
  `sudo bash deploy/ops/install.sh --recipient pt-backup-recipient.asc` (it refuses any file that
  contains a private key and prints the fingerprint to compare).
- Rotation: every 2 years or on suspicion. New key pair, install the new recipient; keep the old
  private key until the last set encrypted to it has expired (12 months).

## 3. Daily operation

```bash
systemctl list-timers 'pt-*'                     # next and last runs
journalctl -u pt-backup-db -n 20 --no-pager      # "backup set <id> complete", integrity, retention
ls /var/backups/pt/sets/                          # sets present
sudo -u ubuntu /usr/local/lib/pt-ops/pt-backup-db.sh --check-only   # verify every set's SHA-256
sudo -u ubuntu /usr/local/lib/pt-ops/pt-backup-db.sh --prune-dry-run
sudo systemctl start pt-backup-db.service        # ad-hoc backup (e.g. before a migration)
```

Failure alerts come from `OnFailure=`; `pt-health` reports `backup: last successful backup N h ago`
once `PT_BACKUP_EXPECTED=1` (set by `install.sh --enable backup`).

## 4. Restore drill (quarterly in production, monthly during the pilot)

The drill runs where the **offline** private key can be used safely: an isolated restore host or
the custodian's workstation with a local PostgreSQL 18 (never the production database). The
script only creates databases named `pt_restore_*`, refuses an existing name, restores in one
transaction and drops the scratch database at the end (unless `--keep`).

```bash
# 1. Copy a set from the server or the offsite store (it is encrypted; the copy is harmless)
scp -r ubuntu@51.79.144.40:/var/backups/pt/sets/<set id> ./sets/
# 2. Make the private key available (smartcard inserted, or a GnuPG home with the imported key)
export PT_RESTORE_GNUPGHOME=~/.gnupg-ptbackup      # optional; default is the user's GnuPG home
# 3. Point at the restore cluster (defaults: 127.0.0.1:5433 as pt_admin, password read from
#    backend/.env.local, or PT_PG_PASSFILE with a pgpass file)
export PT_BACKUP_DIR=$PWD PT_STATE_DIR=$PWD/state
# 4. Run
bash deploy/ops/pt-restore-db.sh --set ./sets/<set id> --db property_token
```

Pass criteria (all printed and written to `drills/drill-<set>-<db>-<time>.txt`):

| Check | Must be |
|---|---|
| `checksums` | SHA256SUMS ok (a corrupted or edited set is refused before decryption) |
| `restore` | pg_restore completed in one transaction |
| `migrations` | equal to the manifest |
| `ledger.verify_chain()`, `ledger.verify_balances()`, `signer.verify_audit()`, `recon.verify_audit()`, `kyc.verify_audit()`, `bank.verify_audit()` | no rows (`SKIP` only for a schema not migrated in that database) |
| `row-counts` | every table equal to the counts taken inside the dump's snapshot |
| `ledger-head` | recorded; compare with the public anchor for that time where anchoring runs |

Evidence: keep the drill report, the set id and the operator names in the private ops records;
note the time taken (it measures the RTO).

### Drill result on the development machine (2026-10-13)

Run on the development laptop (Windows 11, Git Bash, PostgreSQL 18.6 on 127.0.0.1:5433) with a
throw-away GnuPG key pair; read-only dumps of the local databases, restores into `pt_restore_*`
scratch databases that were dropped afterwards. Summary:

- Set `20261013T045539Z` (both databases, 4 files, about 1.1 MB encrypted, 10 s).
- `property_token_test` (migrations 0001–0012, 61 tables, 8,385 rows): all nine checks PASS,
  0 skipped; ledger 604 journals / 1,208 postings, signer audit 360 rows, 20 KYC subjects, 860
  chain events, 105 outbox commands; restore 3 s, whole drill 23 s.
- `property_token` (migrations 0001–0004, 17 tables): PASS; `verify_balances`, recon, KYC and bank
  checks SKIP (not migrated in that database).
- Negative tests: a journal edited by a "rogue DBA" (triggers disabled) in a copy, backed up and
  restored → `ledger.verify_chain()` FAIL, exit 1; one byte changed in an encrypted dump → refused
  at `checksums`, exit 1; target name not `pt_restore_*` → exit 2; a private key given as the
  recipient → refused, exit 2.
- Honest limits: the local `recon.*`, `bank.payout_batches` and `anchor.anchors` tables were empty,
  so those verify functions passed on little data; the drill must be repeated on the demo server's
  data once Step 5h populates them.

## 5. Real restore (disaster recovery)

SEV1, IC + maker-checker. Everything written after the backup is lost from the database; the chain
and the bank statements are independent records and show what must be re-booked.

1. Stop writers: `sudo systemctl stop pt-web pt-console` and every backend worker unit (indexer,
   outbox, signer, bank, anchor from Step 5h). Pause the token if mints/transfers may be in flight.
2. Choose the set (newest that passes its checksums), restore with the drill command into
   `pt_restore_<name>`, with `--keep`. Fresh cluster: add `--globals`, then set every service
   role's password from the secret store (`ALTER ROLE ... PASSWORD`).
3. All drill checks must PASS. A FAIL is a separate incident (tampering or corruption): pick an
   older set and investigate.
4. Swap (DBA, second person watching):
   ```sql
   ALTER DATABASE property_token RENAME TO property_token_broken_<yyyymmdd>;   -- keep as evidence
   ALTER DATABASE pt_restore_<name> RENAME TO property_token;
   ```
5. Start services. Then, in order:
   - `npm run indexer:status` / `indexer:verify`: the read model catches up from the chain; on any
     mismatch follow [indexer-halt.md](indexer-halt.md) (rebuild);
   - `npm run anchor:verify`: proves the restored ledger equals what was anchored up to the backup;
   - import the bank statements since the backup (`npm run recon:import-bank`) and run
     `npm run recon`: every mint, credit or payout after the backup appears as a finding; book each
     one through the services (idempotency keys make retries safe), maker-checker;
   - payouts stay frozen until a run passes and two operators unfreeze
     ([reconciliation-freeze.md](reconciliation-freeze.md)).
6. Record RPO actually lost (time between backup and failure) and RTO achieved.

## 6. Key and secret custody (separate from the data backups)

| Secret | Custody rule |
|---|---|
| `backend/.env.local`, `web/.env.local` values | Sealed escrow copy (password manager vault with two-person access, or printed and split), updated after every rotation; never in a backup set, never in the repository |
| Signer and anchor keystores (`backend/data/keystore`, `backend/data/keystore-anchor`) | Encrypted files (AES-256-GCM, scrypt). Keystore copy in vault A, its passphrase/master key in vault B, held by different people. Production: keys in HSM/MPC; backups are the vendor's wrapped key shares from a recorded ceremony (T-032) |
| Validator node keys | Each validator operator backs up its own key; losing one means a validator-set vote, not a restore |
| Safe owner keys | Hardware wallets with their recovery phrases in separate safes per owner; never photographed or typed into a computer |
| Backup private key | Section 2 |

Test the escrow once a year: a second person proves they can open it (without exposing it).

## 7. Besu data snapshot (one validator at a time)

QBFT keeps finalizing while 3 of 4 validators are up. The script enforces the safety rules:

```bash
/usr/local/lib/pt-ops/pt-besu-snapshot.sh 4 --dry-run          # as ubuntu (never root); read-only check
sudo systemctl start pt-besu-snapshot@4.service                 # or run the script as ubuntu without --dry-run
journalctl -u pt-besu-snapshot@4 -n 30 --no-pager
```

It refuses unless all 4 validators answer, each has 3 peers and blocks are being produced; stops
only node 4; aborts and restarts the node if the other three stop producing blocks; writes
`/var/backups/pt/besu/<id>-node4.tar.gz.gpg` + `.sha256` (chain database only); restarts the node
and waits until it is within 2 blocks of the others with 3 peers. Rotate through nodes 1–4 over
four months; keep the newest `PT_BESU_KEEP` (4) per node.

Restore a validator from a snapshot: stop that node only (`python3 chain/net.py stop node4`), move
`chain/data/node4` aside, decrypt and unpack the snapshot into `chain/data/` (`gpg -d <file> | tar
-xz -C chain/data`), start it (`python3 chain/net.py start node4`); it syncs the missing blocks
from its peers. Without a snapshot, an empty data directory also works: the node resyncs from
genesis (slower). Production: each operator does this on its own host.
