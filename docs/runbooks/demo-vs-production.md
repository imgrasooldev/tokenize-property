# Runbook: demo server specifics versus production

The demo server (`http://51.79.144.40`, OVH VPS-1, 2 vCore / 4 GB / 40 GB, Singapore) runs the whole
stack on one host for presentations. **Not for real users or real money.** This page tells an
operator what is different there, so a demo habit is never carried into production.

## Facts of the demo server

| Item | Demo |
|---|---|
| Services | `pt-stack` (4 Besu validators + PostgreSQL 18 via `chain/net.py` / `backend/scripts/pg.py`), `pt-web` (Next.js on 127.0.0.1:3100 behind nginx :80), `pt-console` (127.0.0.1:4800). Step 5h adds the backend workers; Step 6a adds `pt-admin` |
| Ops units (this pack) | `pt-ops-health`, `pt-backup-db`, `pt-recon`, `pt-anchor-verify`, `pt-audit-chains` timers (OFF until enabled), `pt-besu-snapshot@N`, `pt-ops-alert@` |
| Ports | 22 (keys only), 80; 443 opened by Ploi but unused. RPC, PostgreSQL, console on 127.0.0.1; Besu P2P on 127.0.0.1 |
| Chain | ID 586586 (local dev only, 60 s timelock), dev keys generated on the server |
| Web flags | `WEB_PLAIN_HTTP=1` (no Secure cookie/HSTS), `WEB_DEMO_SIGNER=1` (local dev-key signer) |
| Deploys | GitHub Actions after CI on `main`, CI key with forced command → `update.sh <sha>` |
| Other access | Ploi "Plain Server" (Ploi root key, UFW, local mail relay); config backup `/root/pt-backup-before-ploi.tgz` |
| Memory | 4 GB + 4 GB swap; Besu heaps 320 MB each (`stack.env`) |

## Demo habits that are wrong in production

| On the demo | In production |
|---|---|
| Stop/start validators from the console to show fault tolerance | Validators belong to four organisations; nobody stops another's node |
| `python chain/net.py reset`, `indexer:reset-local`, `signer:setup`, `anchor:setup`, `kyc:setup`, `bank:setup` | Forbidden (dev only); production keys come from key ceremonies, data is never reset |
| Pausing with a dev key on the command line (`cast send ... --private-key`) | Pauser hardware wallet or a Safe transaction |
| Recon failing every day (no rent/mint journals yet) | A failing recon is a SEV2 that blocks payouts |
| One host: chain, DB, web, console, backups on one disk | Separate hosts and tiers; offsite backups; replica |
| Ops scripts connect as the PostgreSQL admin | Dedicated least-privilege roles (backup role with `pg_read_all_data`, recon role per `0006_recon.sql` R-7) over TLS |
| Plain HTTP, IP address only | TLS, domain, WAF |
| Whoever can merge to `main` can reach root through `update.sh` + sudo | Deploy identity separated from admin; no standing root; change approval |

## Operating the demo

```bash
ssh ubuntu@51.79.144.40
sudo systemctl status pt-stack pt-web pt-console --no-pager
python3 ~/property-token/chain/net.py status
sudo /usr/local/lib/pt-ops/pt-health.sh               # after install.sh
ssh -L 4800:127.0.0.1:4800 ubuntu@51.79.144.40         # console in a local browser
```

The full gap list towards production is in [OPERATIONS.md](../OPERATIONS.md) section 9.
