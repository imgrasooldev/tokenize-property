# Runbook: deploy and rollback

How code reaches the demo server, how to undo a bad deploy, and the migration rules that make
rollback safe. Contracts are not deployed this way: all contract deployments go through
`contracts/script/DeployLib.sol`, and changes to live contracts go through the 72 h timelock.

## The pipeline (demo server)

1. A commit lands on `main` → the `CI` workflow runs (tests, lint, Slither, audit).
2. On success, `Deploy demo` (`.github/workflows/deploy-demo.yml`) connects with the CI-only key.
   Its `authorized_keys` entry is a forced command (`~/pt-ci-entry.sh`, copy of
   `deploy/demo-server/ci-entry.sh`): it accepts only a 40-hex SHA and runs `update.sh <sha>`.
3. `deploy/demo-server/update.sh <sha>` refuses a commit that is not on `main`, checks it out,
   runs `npm ci` + `npm run migrate` in `backend/`, rebuilds the website (site down about two
   minutes; an EXIT trap always restarts `pt-web`), restarts the console, publishes mockups and
   nginx config, then smoke-tests `/login`. The chain and its data are never touched.
4. The workflow smoke-tests `http://<DEMO_HOST>/login` from outside.

Manual deploy of one exact commit (on the server):

```bash
cd ~/property-token && bash deploy/demo-server/update.sh <40-hex sha on main>
```

## Before a deploy that adds a migration

```bash
sudo systemctl start pt-backup-db.service      # ad-hoc encrypted backup (kept by the 48 h rule)
journalctl -u pt-backup-db -n 5 --no-pager      # "backup set <id> complete"
```

## Migration rules (from MEMORY section 5; enforced by the runner's checksums)

- **Never edit, rename or delete an applied migration.** The runner refuses changed checksums.
- Migrations are forward-only; there are no down-migrations. Fix a bad migration with a **new**
  migration.
- Numbering has no gaps; a migration that needs another branch's migration waits for it.
- Prefer expand/contract: add new columns/functions first, switch code, remove old ones in a later
  release. Then the previous code still works against the new schema, which is what makes a code
  rollback safe.
- Append-only tables (ledger, audits, outbox history, chain read model, recon, anchor, KYC, bank)
  are never "fixed" by UPDATE/DELETE; a correction is a new, audited record.

## Rollback decision

| Situation | Action |
|---|---|
| Bad commit, no migration in it | **Roll forward** (preferred): `git revert <sha>` on a branch, PR, CI, merge; the pipeline deploys. Fast path when urgent: `bash deploy/demo-server/update.sh <last good sha on main>` |
| Bad commit with a migration that is backward-compatible (expand only) | Same as above: older code runs on the newer schema. Check: `git diff --name-only <good> <bad> -- backend/packages/db/migrations` |
| Bad commit with a migration that breaks older code | Do **not** run older code against it. Write a new forward migration that repairs, deploy it. Restore from backup only for data corruption, as a SEV1 with maker-checker, knowing it loses everything after the backup ([backup-restore.md](backup-restore.md)) |
| Website down after deploy (`http` CRIT) | `sudo systemctl status pt-web`; `tail -40 /tmp/pt-build.log`; `sudo systemctl restart pt-web`; if the build failed, deploy the last good sha |
| Deploy stuck ("another update is running") | A previous update holds `/tmp/pt-update.lock`; check `ps aux | grep pt-update`; wait or stop that process, then re-run |

Find the last good commit: the Actions tab ("Deploy demo" runs) or `git -C ~/property-token log
--oneline -5` on the server (the checkout is a detached HEAD at the deployed SHA).

## After a deploy or rollback

```bash
sudo /usr/local/lib/pt-ops/pt-health.sh     # all checks
cd ~/property-token/backend && npm run migrate   # applies nothing when the schema is in sync
sudo bash deploy/ops/install.sh             # refresh ops scripts if deploy/ops changed (until update.sh does it)
```

## Production differences

Deploys need two reviewers and CI on protected `main` with signed commits (T-014), a deploy
identity via OIDC instead of a long-lived SSH key, blue/green or rolling deploys without downtime,
change records, and a separate approval for migrations that touch money tables.
