#!/usr/bin/env bash
# Updates the demo server to one exact commit of main: code, dependencies, migrations, web build,
# mockups and nginx config, then restarts the website and console. The chain and its data stay.
#   bash deploy/demo-server/update.sh <40-character commit SHA>
# Run by the "Deploy demo" GitHub workflow through ci-entry.sh, or by hand on the server.
#
# Bash reads a script while it runs, and `git checkout` rewrites this file, so it never runs from
# the repository copy: stage 1 runs from a temporary copy and checks out the commit; stage 2 runs
# from a temporary copy of the checked-out version, so new steps apply in the same deploy.
set -euo pipefail
SHA="${1:-}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "usage: update.sh <40-hex commit sha>" >&2; exit 2; }
REPO=/home/ubuntu/property-token
SELF="$REPO/deploy/demo-server/update.sh"
cd "$REPO"

run_copy() { # stage
  local copy; copy=$(mktemp /tmp/pt-update.XXXXXX)
  cp "$SELF" "$copy"
  PT_UPDATE_STAGE="$1" exec bash "$copy" "$SHA"
}

case "${PT_UPDATE_STAGE:-}" in
"")
  run_copy checkout
  ;;
checkout)
  exec 9>/tmp/pt-update.lock
  flock -n 9 || { echo "another update is running" >&2; exit 3; }
  echo "== code $SHA"
  git fetch --quiet origin main
  git merge-base --is-ancestor "$SHA" origin/main || { echo "$SHA is not on main" >&2; exit 4; }
  git checkout --quiet --force --detach "$SHA"
  git submodule update --init --recursive --quiet
  run_copy build # keeps fd 9, so the lock is held until the end
  ;;
build) ;;
*) echo "unknown stage" >&2; exit 2 ;;
esac

# Always bring the website back, whatever fails below.
trap 'sudo systemctl start pt-web || true' EXIT

echo "== backend dependencies and migrations"
(cd backend && npm ci --ignore-scripts --no-audit --no-fund --silent && npm run --silent migrate)

echo "== web build (the site is down for about two minutes)"
sudo systemctl stop pt-web
(cd web && npm ci --ignore-scripts --no-audit --no-fund --silent \
  && NODE_ENV=production WEB_PLAIN_HTTP=1 NODE_OPTIONS=--max-old-space-size=1536 npx next build >/tmp/pt-build.log 2>&1) \
  || { tail -40 /tmp/pt-build.log; exit 5; }
git checkout --quiet -- web/next-env.d.ts 2>/dev/null || true
sudo systemctl start pt-web
sudo systemctl restart pt-console

echo "== internal portals (admin/): 127.0.0.1:3300 only, reached through an SSH tunnel, never nginx"
sudo systemctl stop pt-admin 2>/dev/null || true
(cd admin && npm ci --ignore-scripts --no-audit --no-fund --silent && node scripts/setup-server.mjs \
  && NODE_ENV=production ADMIN_ORIGIN=http://localhost:3300 NODE_OPTIONS=--max-old-space-size=1536 npx next build >/tmp/pt-admin-build.log 2>&1) \
  || { tail -40 /tmp/pt-admin-build.log; exit 7; }
git checkout --quiet -- admin/next-env.d.ts 2>/dev/null || true
if ! sudo cmp -s deploy/demo-server/pt-admin.service /etc/systemd/system/pt-admin.service; then
  sudo cp deploy/demo-server/pt-admin.service /etc/systemd/system/pt-admin.service
  sudo systemctl daemon-reload
fi
sudo systemctl enable pt-admin >/dev/null 2>&1 || true
sudo systemctl start pt-admin

echo "== design mockups -> /mockups/ and nginx config"
sudo bash deploy/demo-server/publish-mockups.sh
if ! sudo cmp -s deploy/demo-server/nginx.conf /etc/nginx/sites-available/property-token; then
  sudo cp deploy/demo-server/nginx.conf /etc/nginx/sites-available/property-token
  sudo nginx -t && sudo systemctl reload nginx
fi

echo "== smoke test"
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/login || true)
  if [ "$code" = 200 ]; then
    echo "website up ($SHA)"
    # The portal must answer on loopback only (Host = its localhost origin) and never on port 80.
    for _ in $(seq 1 30); do
      a=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: localhost:3300' http://127.0.0.1:3300/api/health || true)
      [ "$a" = 200 ] && { echo "admin portal up on 127.0.0.1:3300"; exit 0; }
      sleep 2
    done
    echo "admin portal did not come up (last HTTP $a)" >&2
    exit 8
  fi
  sleep 2
done
echo "website did not come back (last HTTP $code)" >&2
exit 6
