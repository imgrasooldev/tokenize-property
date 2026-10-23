#!/usr/bin/env bash
# One-time application setup on the demo server, as the app user, after provision.sh:
#   bash deploy/demo-server/setup.sh
# Same steps as a new development machine (docs/demo-guide.md), with a production web build.
# Creates NEW local dev keys and a fresh chain; nothing secret leaves the server.
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; . deploy/demo-server/stack.env; set +a

echo "== tool links (net.py and pg.py look in chain/tools and backend/tools)"
mkdir -p chain/tools backend/tools
ln -sfn /opt/jdk-25 chain/tools/jdk-25
ln -sfn /usr/lib/postgresql/18 backend/tools/pgsql
test -x chain/tools/besu-26.9.0/bin/besu || { echo "chain/tools/besu-26.9.0 missing (upload the verified zip)"; exit 1; }

echo "== web: install and production build (before the chain starts, to keep memory free)"
(cd web && npm ci --ignore-scripts --no-audit --no-fund && npm run setup:demo \
  && NODE_ENV=production WEB_PLAIN_HTTP=1 NODE_OPTIONS=--max-old-space-size=1536 npx next build)
git checkout -- web/next-env.d.ts 2>/dev/null || true

echo "== backend: install"
(cd backend && npm ci --ignore-scripts --no-audit --no-fund)

echo "== chain: dev accounts, 4 validator keys, genesis; start"
python3 chain/net.py setup
python3 chain/net.py start

echo "== PostgreSQL cluster on 127.0.0.1:5433 and migrations"
python3 backend/scripts/pg.py setup
(cd backend && npm run migrate)

echo "== internal portals (admin/): least-privilege database login and production build (127.0.0.1:3300)"
(cd admin && npm ci --ignore-scripts --no-audit --no-fund && node scripts/setup-server.mjs \
  && NODE_ENV=production ADMIN_ORIGIN=http://localhost:3300 NODE_OPTIONS=--max-old-space-size=1536 npx next build)
git checkout -- admin/next-env.d.ts 2>/dev/null || true

echo "== contracts: deploy through DeployLib and run the end-to-end flow (creates Alice and Bob)"
python3 chain/flow.py

echo "== a rent distribution to verify on the website"
python3 chain/rent.py 300000

echo "== backend services' secrets, keys and database roles: website + one login per service, T-012 (idempotent, nothing printed)"
(cd backend && npm run --silent kyc:setup >/dev/null && npm run --silent bank:setup >/dev/null && npm run --silent signer:setup >/dev/null && npm run --silent db:web-role >/dev/null && npm run --silent db:service-roles >/dev/null)

echo "setup done; start the services with:"
echo "  sudo systemctl start pt-stack pt-indexer pt-signer pt-kyc pt-bank-payees pt-outbox pt-offboarding pt-web pt-console"
echo "then, once the indexer has caught up (npm run indexer:status in backend/): npm run seed:local && npm run rent:book"
