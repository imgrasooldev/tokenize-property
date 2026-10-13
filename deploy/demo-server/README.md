# Private IP demo server

A private demo of the whole stack on one small VPS: four Besu QBFT validators (chain 586586,
local dev keys), PostgreSQL 18, the website (Next.js production build behind nginx on port 80)
and the Live Demo Console (127.0.0.1 only).

| | |
|---|---|
| Server | OVH VPS-1 2027 (2 vCore, 4 GB, 40 GB NVMe), Singapore, display name `property-token-demo` |
| Address | `http://51.79.144.40` (plain HTTP by owner decision: demo only, no domain yet) |
| Open ports | 22 (SSH, keys only), 80, and 443 (opened by Ploi, unused). Chain RPC, PostgreSQL and the console listen on 127.0.0.1; Besu P2P ports are firewalled |
| Data | Demo data only. Dev keys are generated on the server and never leave it |

**Not for real users or real money.** Before that: TLS, HSM/MPC signing (ADR 0005), separate
validator operators, backups and monitoring (see `docs/security-standards.md`).

## First install

```bash
# on the server, as ubuntu
git clone --recurse-submodules https://github.com/imgrasooldev/tokenize-property.git property-token
# from a development machine: the Besu zip verified in chain/README.md
scp chain/tools/besu-26.9.0.zip ubuntu@51.79.144.40:property-token/chain/tools/
# on the server
cd property-token && (cd chain/tools && unzip -q besu-26.9.0.zip)
sudo bash deploy/demo-server/provision.sh   # OS packages, firewall, swap, services, CI key
bash deploy/demo-server/setup.sh            # build, chain, database, contracts, demo data
sudo systemctl start pt-stack pt-indexer pt-signer pt-kyc pt-outbox pt-offboarding pt-web pt-console
(cd backend && npm run seed:local && npm run rent:book)   # once the indexer has caught up
```

## Updates (GitHub Actions)

`.github/workflows/deploy-demo.yml` runs after CI passes on `main` (or by hand). It connects with
a CI-only SSH key whose `authorized_keys` entry is a forced command (`ci-entry.sh`): the key can
only run `update.sh <commit>` for a commit that is on `main`. `update.sh` pulls that commit,
installs dependencies, migrates, runs the idempotent backend setup, installs and restarts the
backend services, rebuilds the website and restarts it; the chain is untouched.

Repository settings needed (Settings > Secrets and variables > Actions, environment `demo`):

| Name | Kind | Value |
|---|---|---|
| `DEMO_HOST` | variable | `51.79.144.40` (deploys stay skipped until this is set) |
| `DEMO_SSH_KEY_PROPERTY` | secret | private half of `ci-deploy.pub` |
| `DEMO_KNOWN_HOSTS` | secret | `ssh-keyscan -t ed25519 51.79.144.40` output, checked against the server |

## Ploi

The server is also connected to Ploi as a **Plain Server** (UFW, Supervisor, a `ploi` user and
Ploi's root key; no nginx, PHP or database from Ploi), named `property-token-demo`. Ploi opened
443 in UFW and installed a local-only mail relay (127.0.0.1:25/587). The app stack above stays
managed by these scripts and systemd, not by Ploi. A config backup taken before connecting Ploi is
at `/root/pt-backup-before-ploi.tgz`.

## Backend services (Step 5h, ADR 0010)

Since Step 5h the website signs nothing and reads the chain index; these services do the rest. All
bind to 127.0.0.1, run as `ubuntu` with a small heap (`--max-old-space-size` 128–160 MB) and a
`MemoryMax` of 256–320 MB, and restart on failure, except the indexer after a **halt** (exit 3:
the chain does not match the read model; fail closed, find the cause, ADR 0006).

| Unit | What | Port |
|---|---|---|
| `pt-indexer` | Read model in schema `chain` | – |
| `pt-signer` | Signing service: dev keys and custodial wallets in `backend/data/keystore`, policies, maker-checker, audit | 4900 |
| `pt-outbox` | Outbox worker: every chain command through the signing service | – |
| `pt-kyc` | KYC API for the website's sign-up (mock providers) | 4910 |
| `pt-offboarding` | Queues a freeze when an investor loses verification | – |

`update.sh` installs new or changed `pt-*.service` units, enables and restarts the five services
and runs the setup steps, all idempotent: `kyc:setup` and `signer:setup` create secrets only when
missing (appended to the git-ignored `backend/.env.local`, never printed), `signer:setup` proposes
a policy only when it changed, `db:web-role` creates or re-asserts the website's database role
`pt_web_app` (its password is generated once into `backend/.env.local`), and
`signer:import-web-wallets` moves wallet keys of earlier sign-ups into the signing service once
and deletes the website's copy. Migrations 0005–0012 are applied by the existing `npm run migrate`
step. After the indexer has caught up it books the demo records for reconciliation
(`seed:local`, `rent:book`; a failure there is reported, not fatal). The smoke test checks the
signer and KYC health endpoints, that the indexer, outbox and offboarding units are active, and
the website. Any failure before the web build leaves the previous website running (EXIT trap).

### Demo liquidity (optional, off by default)

The market chart needs trades. `web/tools/market-demo.ts` makes Alice and Bob trade through the
real market code; since Step 5h every delivery goes through the outbox and the signing service
(their dev keys are custodial wallets of the signer), so the services above must run. By hand:

```bash
cd ~/property-token/web && npx tsx tools/market-demo.ts 40 8   # 40 trades, 8 s apart
```

Automatically, a few trades every four hours (`pt-demo-market.timer` → `pt-demo-market.service`,
6 rounds 20 s apart). It is **off** unless the flag file exists; `update.sh` applies the flag on
every deploy (idempotent):

```bash
sudo mkdir -p /etc/pt && sudo touch /etc/pt/demo-market.enabled   # on (next deploy, or:)
sudo systemctl enable --now pt-demo-market.timer
sudo rm /etc/pt/demo-market.enabled && sudo systemctl disable --now pt-demo-market.timer   # off
systemctl list-timers pt-demo-market.timer; journalctl -u pt-demo-market --since today
```

These are demo trades between the two demo personas, labelled DEMO on the market page like all
trading on this server.

### First rollout of Step 5h (the lead, once)

The GitHub deploy does all of the above by itself. To watch the first one or to run it by hand:

```bash
ssh ubuntu@51.79.144.40
cd property-token
bash deploy/demo-server/update.sh <commit sha on main>   # or let "Deploy demo" run after CI
sudo systemctl status pt-indexer pt-signer pt-outbox pt-kyc pt-offboarding pt-web --no-pager
(cd backend && npm run indexer:status && npm run signer:audit)
(cd backend && npm run recon:demo-bank && npm run recon)   # expect PASS; see notes below
free -m                                                  # memory with the five new services
```

Notes:
- The first indexer catch-up reads the whole chain (about 10–30 s per 50,000 blocks here).
- Reconciliation on this server reports earlier website activity as it really is: subscriptions
  and trades made before Step 5h are booked under `web:sub:*` and reconcile; anything the old demo
  signer left in `review` stays in review for an operator. `recon:demo-bank` imports statements
  for every day since the first website payment.
- Large investments or trades (over 10,000 tokens) now wait for two operators:
  `npm run signer:decide -- <requestId> <operator> approve "<reason>"` (twice, by different names).

## Operating

```bash
sudo systemctl status pt-stack pt-web pt-console pt-indexer pt-signer pt-outbox pt-kyc pt-offboarding
python3 chain/net.py status
ssh -L 4800:127.0.0.1:4800 ubuntu@51.79.144.40   # then open http://127.0.0.1:4800 (console)
```
