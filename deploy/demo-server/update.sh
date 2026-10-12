#!/usr/bin/env bash
# Updates the demo server to one exact commit of main: code, dependencies, migrations, web build,
# then restarts the website and console. The chain and its data are left as they are.
#   bash deploy/demo-server/update.sh <40-character commit SHA>
# Run by the "Deploy demo" GitHub workflow through ci-entry.sh, or by hand on the server.
set -euo pipefail
SHA="${1:-}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "usage: update.sh <40-hex commit sha>" >&2; exit 2; }

cd /home/ubuntu/property-token
exec 9>/tmp/pt-update.lock
flock -n 9 || { echo "another update is running" >&2; exit 3; }

echo "== code $SHA"
git fetch --quiet origin main
git merge-base --is-ancestor "$SHA" origin/main || { echo "$SHA is not on main" >&2; exit 4; }
git checkout --quiet --force --detach "$SHA"
git submodule update --init --recursive --quiet

echo "== backend dependencies and migrations"
(cd backend && npm ci --ignore-scripts --no-audit --no-fund --silent && npm run --silent migrate)

echo "== web build (the site is down for about two minutes)"
sudo systemctl stop pt-web
(cd web && npm ci --ignore-scripts --no-audit --no-fund --silent \
  && NODE_ENV=production WEB_PLAIN_HTTP=1 NODE_OPTIONS=--max-old-space-size=1536 npx next build >/tmp/pt-build.log 2>&1) \
  || { tail -40 /tmp/pt-build.log; sudo systemctl start pt-web; exit 5; }
git checkout --quiet -- web/next-env.d.ts 2>/dev/null || true
sudo systemctl start pt-web
sudo systemctl restart pt-console

echo "== smoke test"
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/login || true)
  [ "$code" = 200 ] && { echo "website up ($SHA)"; exit 0; }
  sleep 2
done
echo "website did not come back (last HTTP $code)" >&2
exit 6
