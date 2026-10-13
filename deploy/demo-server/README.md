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
sudo systemctl start pt-stack pt-web pt-console pt-admin
```

## Updates (GitHub Actions)

`.github/workflows/deploy-demo.yml` runs after CI passes on `main` (or by hand). It connects with
a CI-only SSH key whose `authorized_keys` entry is a forced command (`ci-entry.sh`): the key can
only run `update.sh <commit>` for a commit that is on `main`. `update.sh` pulls that commit,
installs dependencies, migrates, rebuilds the website and restarts it; the chain is untouched.

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

## Internal portals (PT Control, Step 6)

`pt-admin.service` runs the officers' portal (`admin/`, ADR 0011) on **127.0.0.1:3300 only**. It
is **not** in nginx and port 3300 is not opened in ufw (owner decision, option A: not publicly
exposed). Officers reach it through an SSH tunnel and open `http://localhost:3300` (WebAuthn
needs a secure context; browsers treat `localhost` as one, so the `__Host-` Secure session cookie
works without TLS; an IP address cannot be a WebAuthn RP ID, so `http://127.0.0.1:3300` is refused
with 421).

```bash
# once, on the server: the first (and optionally a second) bootstrap administrator
cd ~/property-token/admin && npm run officer -- bootstrap <handle> "<Full Name>"   # prints a one-time link (30 min)
# on the officer's own machine, with a FIDO2 security key
ssh -L 3300:127.0.0.1:3300 ubuntu@51.79.144.40   # then open the printed http://localhost:3300/enrol#token=... link
# later officers: invited and approved by two administrators in the portal, then on the server
npm run officer -- enrol-link <handle>
```

`update.sh` installs and builds `admin/`, (re)creates its database login `pt_admin_web` (member of
`pt_admin_portal` only, new random password in the git-ignored `admin/.env.local`) and restarts
the unit; the smoke test checks `/api/health` on loopback.

## Operating

```bash
sudo systemctl status pt-stack pt-web pt-console pt-admin
python3 chain/net.py status
ssh -L 4800:127.0.0.1:4800 ubuntu@51.79.144.40   # then open http://127.0.0.1:4800 (console)
ssh -L 3300:127.0.0.1:3300 ubuntu@51.79.144.40   # then open http://localhost:3300 (internal portals)
```
